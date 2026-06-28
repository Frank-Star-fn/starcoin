const { Block, Transaction } = require('./core');

/**
 * 查询引擎：负责链上的所有"只读"查询操作
 * - 按区块号/交易ID/地址/备注搜索
 * - 所有方法都不修改链状态
 *
 * 通过 this.blockchain 反向引用访问：
 *   this.blockchain.chain                → 区块数组
 *   this.blockchain.pendingTransactions  → 交易池
 *   this.blockchain.getBalance(...)      → 余额查询
 *   this.blockchain.getTransactionHistory(...) → 交易历史
 *   this.blockchain.getLockedRewards(...)     → 锁定奖励
 *   this.blockchain.getLatestBlock()          → 最新区块
 */
class QueryEngine {
    constructor(blockchain) {
        this.blockchain = blockchain;
    }

    // ============================================================
    //  搜索方法：按区块号 / 交易ID / 地址 / 备注搜索
    // ============================================================

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
            const balance = this.blockchain.getBalance(q);
            const totalBalance = this.blockchain.getBalance(q, true);
            const lockedRewards = this.blockchain.getLockedRewards(q);
            const history = this.blockchain.getTransactionHistory(q);
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
                    transactions: history.slice(0, 10) // 最近 10 笔
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
                    balance: this.blockchain.getBalance(addr),
                    txCount: this.blockchain.getTransactionHistory(addr).length
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
}

module.exports = { QueryEngine };