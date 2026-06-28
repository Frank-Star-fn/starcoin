const { Block, Transaction,
        SUPPORTED_CURRENCIES, DEFAULT_CURRENCY, effectiveCurrency } = require('../core');

/**
 * 查询引擎：只读查询操作（区块/交易/地址/备注搜索、余额、手续费统计）
 */
class QueryEngine {
    constructor(blockchain) {
        this.blockchain = blockchain;
    }

    /**
     * 按区块索引查找区块
     * @param {number} index - 区块高度
     * @returns {object|null} 区块对象，越界返回 null
     */
    findBlockByIndex(index) {
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= this.blockchain.chain.length) {
            return null;
        }
        return this.blockchain.chain[index];
    }

    /**
     * 按交易 ID 查找交易（遍历全链）
     * @param {string} txId - 交易 ID（64位 hex 或部分匹配）
     * @returns {object|null} { block, transaction, confirmations } 或 null
     */
    findTransactionById(txId) {
        if (!txId || typeof txId !== 'string') return null;
        const query = txId.trim().toLowerCase();
        if (!query) return null;

        const latestIndex = this.blockchain.getLatestBlock().index;

        // 正向遍历（从创世到最新），找到第一个完全匹配或前缀匹配的交易
        for (let i = 0; i < this.blockchain.chain.length; i++) {
            const block = this.blockchain.chain[i];
            if (!block.transactions || !Array.isArray(block.transactions)) continue;
            for (const tx of block.transactions) {
                if (!tx.id) continue;
                const txIdLower = tx.id.toLowerCase();
                // 支持完整匹配和前缀匹配（用户可能只输入前几位）
                if (txIdLower === query || txIdLower.startsWith(query) || query.startsWith(txIdLower)) {
                    return {
                        block,
                        blockIndex: block.index,
                        blockHash: block.hash,
                        transaction: tx,
                        confirmations: latestIndex - block.index
                    };
                }
            }
        }
        return null;
    }

    /**
     * 统一智能搜索
     * 自动判断查询类型：区块号 / 交易ID / 地址 / 备注文本
     *
     * @param {string} query - 用户输入的搜索关键词
     * @returns {object} { type, result, query }
     */
    search(query) {
        if (!query || typeof query !== 'string') {
            return { type: 'empty', result: null, query };
        }

        const q = query.trim();

        // ── 1) 纯数字 → 按区块号搜索 ──
        const asNumber = Number(q);
        if (Number.isInteger(asNumber) && asNumber >= 0 && String(asNumber) === q) {
            const block = this.findBlockByIndex(asNumber);
            if (block) {
                // 统计本块燃烧手续费
                let blockBurnedFees = 0;
                if (block.transactions && Array.isArray(block.transactions)) {
                    for (const tx of block.transactions) {
                        blockBurnedFees += Number(tx.fee) || 0;
                    }
                }
                return {
                    type: 'block',
                    result: {
                        block,
                        transactionCount: (block.transactions || []).length,
                        totalBurnedFees: blockBurnedFees
                    },
                    query: q
                };
            }
            // 数字但越界 → 返回 not_found 但提示最大区块号
            return {
                type: 'not_found',
                result: {
                    message: `区块 #${asNumber} 不存在`,
                    hint: `当前链高度: 0 ~ ${this.blockchain.chain.length - 1}`
                },
                query: q
            };
        }

        // ── 2) 64位 hex（sha256）→ 按交易ID 或 区块hash 搜索 ──
        const hexPattern = /^[0-9a-fA-F]{6,64}$/;
        if (hexPattern.test(q)) {
            // 2a) 先搜交易 ID
            const txResult = this.findTransactionById(q);
            if (txResult) {
                return { type: 'transaction', result: txResult, query: q };
            }
            // 2b) 再搜区块 hash（前缀匹配）
            for (let i = 0; i < this.blockchain.chain.length; i++) {
                const block = this.blockchain.chain[i];
                if (block.hash && block.hash.toLowerCase() === q.toLowerCase()) {
                    let blockBurnedFees = 0;
                    if (block.transactions && Array.isArray(block.transactions)) {
                        for (const tx of block.transactions) {
                            blockBurnedFees += Number(tx.fee) || 0;
                        }
                    }
                    return {
                        type: 'block',
                        result: {
                            block,
                            transactionCount: (block.transactions || []).length,
                            totalBurnedFees: blockBurnedFees
                        },
                        query: q
                    };
                }
            }
        }

        // ── 3) 32位 hex（地址长度）→ 按地址搜索 ──
        if (hexPattern.test(q) && q.length === 32) {
            const balance = this.getBalance(q);
            const totalBalance = this.getBalance(q, true);
            const lockedRewards = this.getLockedRewards(q);
            const history = this.getTransactionHistory(q);
            const pendingCount = this.blockchain.pendingTransactions.filter(
                tx => tx.from === q || tx.to === q
            ).length;
            return {
                type: 'address',
                result: {
                    address: q,
                    balance,
                    totalBalance,
                    lockedRewards,
                    transactionCount: history.length,
                    pendingTransactions: pendingCount,
                    transactions: history.slice(0, 10)
                },
                query: q
            };
        }

        // ── 4) 地址前缀模糊搜索（短地址如 "abc123"） ──
        if (q.length >= 6 && hexPattern.test(q)) {
            // 在链中搜索匹配的地址
            const addressSet = new Set();
            for (const block of this.blockchain.chain) {
                if (!block.transactions) continue;
                for (const tx of block.transactions) {
                    if (tx.from && tx.from.toLowerCase().startsWith(q.toLowerCase())) addressSet.add(tx.from);
                    if (tx.to && tx.to.toLowerCase().startsWith(q.toLowerCase())) addressSet.add(tx.to);
                }
            }
            if (addressSet.size > 0) {
                const results = Array.from(addressSet).slice(0, 10).map(addr => ({
                    address: addr,
                    balance: this.getBalance(addr),
                    txCount: this.getTransactionHistory(addr).length
                }));
                return {
                    type: 'address_list',
                    result: {
                        addresses: results,
                        total: addressSet.size,
                        message: `找到 ${addressSet.size} 个匹配的地址`
                    },
                    query: q
                };
            }
        }

        // ── 5) 备注模糊搜索 ──
        const qLower = q.toLowerCase();
        const matchedTxs = [];
        for (let i = 0; i < this.blockchain.chain.length; i++) {
            const block = this.blockchain.chain[i];
            if (!block.transactions) continue;
            for (const tx of block.transactions) {
                if (tx.note && tx.note.toLowerCase().includes(qLower)) {
                    matchedTxs.push({
                        ...tx,
                        blockIndex: block.index,
                        blockHash: block.hash
                    });
                    if (matchedTxs.length >= 20) break; // 最多返回 20 条
                }
            }
            if (matchedTxs.length >= 20) break;
        }
        if (matchedTxs.length > 0) {
            return {
                type: 'note',
                result: {
                    transactions: matchedTxs,
                    total: matchedTxs.length,
                    message: `在备注中找到 ${matchedTxs.length} 条匹配记录`
                },
                query: q
            };
        }

        // ── 6) 搜索交易池（待打包交易） ──
        const pendingMatches = this.blockchain.pendingTransactions.filter(tx => {
            const txId = (tx.id || '').toLowerCase();
            const from = (tx.from || '').toLowerCase();
            const to = (tx.to || '').toLowerCase();
            const note = (tx.note || '').toLowerCase();
            const ql = q.toLowerCase();
            return txId.includes(ql) || from.includes(ql) || to.includes(ql) || note.includes(ql);
        });
        if (pendingMatches.length > 0) {
            return {
                type: 'mempool',
                result: {
                    transactions: pendingMatches,
                    total: pendingMatches.length,
                    message: `在交易池中找到 ${pendingMatches.length} 条匹配记录`
                },
                query: q
            };
        }

        // ── 未匹配任何结果 ──
        return {
            type: 'not_found',
            result: { message: `未找到与 "${q}" 相关的任何结果` },
            query: q
        };
    }

    // ============================================================
    //  余额查询（从 blockchain.js 迁入）
    // ============================================================

    /**
     * 获取指定地址的余额（默认返回 STC 数值，保持与旧代码 100% 兼容）。
     * currency 可选：'STC' | 'cBTC' | 'cETH'
     */
    getBalance(address, includeImmature = false, currency = DEFAULT_CURRENCY) {
        if (!address) return 0;
        const targetCurrency = effectiveCurrency(currency);
        let balance = 0;
        for (const block of this.blockchain.chain) {
            for (const tx of block.transactions) {
                const c = effectiveCurrency(tx);

                if (tx.from === address) {
                    // amount 始终按交易币种扣除
                    if (c === targetCurrency) {
                        balance -= Number(tx.amount) || 0;
                    }
                    // fee 始终从 STC 扣除（无论交易币种）
                    if (targetCurrency === DEFAULT_CURRENCY) {
                        balance -= Number(tx.fee) || 0;
                    }
                }
                if (tx.to === address) {
                    if (c !== targetCurrency) continue;
                    if (tx.from === 'SYSTEM' && !includeImmature) {
                        if (!this.blockchain._isCoinbaseMature(block.index)) continue;
                    }
                    balance += Number(tx.amount) || 0;
                }
            }
        }
        return balance;
    }

    /** 内部：返回 { STC: 0, cBTC: 0, cETH: 0 } */
    _emptyBalances() {
        const obj = {};
        for (const c of SUPPORTED_CURRENCIES) obj[c] = 0;
        return obj;
    }

    /**
     * 获取全币种余额对象（一次性遍历链，返回 { STC, cBTC, cETH }）。
     * amount 按交易币种扣除，fee 始终从 STC 扣除。
     */
    getAllBalances(address, includeImmature = false) {
        if (!address) return this._emptyBalances();
        const balances = this._emptyBalances();
        for (const block of this.blockchain.chain) {
            for (const tx of block.transactions) {
                const c = effectiveCurrency(tx);
                if (!balances.hasOwnProperty(c)) continue;
                if (tx.from === address) {
                    // amount 按交易币种扣除
                    balances[c] -= Number(tx.amount) || 0;
                    // fee 始终从 STC 扣除
                    balances[DEFAULT_CURRENCY] -= Number(tx.fee) || 0;
                }
                if (tx.to === address) {
                    if (tx.from === 'SYSTEM' && !includeImmature) {
                        if (!this.blockchain._isCoinbaseMature(block.index)) continue;
                    }
                    balances[c] += Number(tx.amount) || 0;
                }
            }
        }
        return balances;
    }

    /**
     * 获取地址的"锁定奖励"金额（未成熟矿工奖励）。
     * 不传 currency 返回 STC（兼容旧代码）；传 'ALL' 返回所有币种对象。
     */
    getLockedRewards(address, currency = DEFAULT_CURRENCY) {
        if (!address) {
            return (currency === 'ALL') ? this._emptyBalances() : 0;
        }
        if (currency === 'ALL') {
            const locked = this._emptyBalances();
            for (const block of this.blockchain.chain) {
                for (const tx of block.transactions) {
                    if (tx.to !== address || tx.from !== 'SYSTEM') continue;
                    const c = effectiveCurrency(tx);
                    if (!locked.hasOwnProperty(c)) continue;
                    if (!this.blockchain._isCoinbaseMature(block.index)) {
                        locked[c] += Number(tx.amount) || 0;
                    }
                }
            }
            return locked;
        }
        const targetCurrency = effectiveCurrency(currency);
        let locked = 0;
        for (const block of this.blockchain.chain) {
            for (const tx of block.transactions) {
                if (tx.to !== address || tx.from !== 'SYSTEM') continue;
                if (effectiveCurrency(tx) !== targetCurrency) continue;
                if (!this.blockchain._isCoinbaseMature(block.index)) {
                    locked += Number(tx.amount) || 0;
                }
            }
        }
        return locked;
    }

    /**
     * 获取地址的所有交易历史（每笔带 currency 字段）
     */
    getTransactionHistory(address) {
        if (!address) return [];
        const history = [];
        for (const block of this.blockchain.chain) {
            for (const tx of block.transactions) {
                if (tx.from === address || tx.to === address) {
                    history.push({
                        ...tx,
                        currency: effectiveCurrency(tx),
                        blockIndex: block.index,
                        blockHash: block.hash,
                        direction: tx.from === address ? 'OUT' : 'IN'
                    });
                }
            }
        }
        return history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    /**
     * 计算全链总燃烧手续费（所有交易的 fee 总和）
     */
    getTotalBurnedFees() {
        let totalFees = 0;
        for (const block of this.blockchain.chain) {
            if (!block.transactions || !Array.isArray(block.transactions)) continue;
            for (const tx of block.transactions) {
                totalFees += Number(tx.fee) || 0;
            }
        }
        return totalFees;
    }

    /**
     * 获取最新 N 个区块的燃烧手续费详情（用于前端图表展示）
     */
    getRecentBurnedFees(count = 20) {
        const result = [];
        const startIdx = Math.max(0, this.blockchain.chain.length - count);
        for (let i = startIdx; i < this.blockchain.chain.length; i++) {
            const block = this.blockchain.chain[i];
            let blockFees = 0;
            let txCount = 0;
            if (block.transactions && Array.isArray(block.transactions)) {
                for (const tx of block.transactions) {
                    const fee = Number(tx.fee) || 0;
                    blockFees += fee;
                    if (fee > 0) txCount++;
                }
            }
            result.push({
                blockIndex: block.index,
                blockHash: block.hash ? block.hash.substring(0, 16) : '',
                totalFees: blockFees,
                txWithFeeCount: txCount,
                totalTxCount: (block.transactions || []).length
            });
        }
        return result;
    }

    /**
     * 计算指定地址的"下一个期望 nonce"。
     * - 从创世块扫描到当前链尾，统计该地址作为 from 的交易数量（非 SYSTEM、非空 from）。
     * - includePending=true 时，额外统计交易池中的数量（用于本地节点添加交易时的验证）。
     * - nonce 从 0 开始：地址首次发送交易时 nonce 应为 0，第二笔为 1，依此类推。
     */
    getAddressNonce(address, includePending = true) {
        if (!address) return 0;
        let count = 0;
        for (const block of this.blockchain.chain) {
            if (!block.transactions || !Array.isArray(block.transactions)) continue;
            for (const tx of block.transactions) {
                if (tx.from !== address) continue;
                if (!tx.from || tx.from === '' || tx.from === 'SYSTEM') continue;
                if (tx.amount <= 0) continue; // 忽略备注交易（amount=0）
                count++;
            }
        }
        if (includePending) {
            for (const tx of this.blockchain.pendingTransactions) {
                if (tx.from !== address) continue;
                if (!tx.from || tx.from === '' || tx.from === 'SYSTEM') continue;
                if (Number(tx.amount) <= 0) continue;
                count++;
            }
        }
        return count;
    }

    /**
     * 仅统计链上已确认的 nonce（不含交易池）。
     * 用于链验证逻辑（验证链上每笔交易的 nonce 是否按顺序递增）。
     */
    getConfirmedNonce(address) {
        if (!address) return 0;
        let count = 0;
        for (const block of this.blockchain.chain) {
            if (!block.transactions || !Array.isArray(block.transactions)) continue;
            for (const tx of block.transactions) {
                if (tx.from !== address) continue;
                if (!tx.from || tx.from === '' || tx.from === 'SYSTEM') continue;
                if (Number(tx.amount) <= 0) continue;
                count++;
            }
        }
        return count;
    }

    /**
     * 获取所有地址及其余额（用于排名展示，每项包含 balances: {STC, cBTC, cETH}）
     */
    getAllAddresses() {
        const map = new Map();
        for (const block of this.blockchain.chain) {
            for (const tx of block.transactions) {
                if (tx.from) map.set(tx.from, (map.get(tx.from) || 0));
                if (tx.to) map.set(tx.to, (map.get(tx.to) || 0));
            }
        }
        const result = [];
        for (const addr of map.keys()) {
            const balances = this.getAllBalances(addr);
            result.push({
                address: addr,
                balance: balances[DEFAULT_CURRENCY],          // 兼容：主币（STC）余额
                balances,                                        // 全币种余额 { STC, cBTC, cETH }
                lockedRewards: this.getLockedRewards(addr),    // 仅 STC 有矿工奖励
                txCount: this.getTransactionHistory(addr).length
            });
        }
        return result.sort((a, b) => b.balance - a.balance);
    }
}

module.exports = { QueryEngine };