const { Block, Transaction } = require('./core');
const logger = require('./logger');

/**
 * 链验证与同步模块
 * 职责：链完整性验证、自动修复、分叉替换（共识）
 *
 * @param {Blockchain} blockchain - Blockchain 实例引用
 */
class ChainSync {
    constructor(blockchain) {
        this.blockchain = blockchain;
        this.log = logger.module('ChainSync');
    }

    // JSON → Transaction 实例（用于签名验证）
    _toTransactionInstance(txObj) {
        if (!txObj) return null;
        // 如果已经是 Transaction 实例，直接返回
        if (txObj instanceof Transaction) return txObj;
        // 从普通对象还原（传入 currency 与 nonce，确保 hash 计算一致）
        const tx = new Transaction(
            txObj.from, txObj.to, txObj.amount,
            txObj.fee || 0, txObj.note || '',
            txObj.currency, txObj.nonce
        );
        if (txObj.id) tx.id = txObj.id;
        if (txObj.timestamp) tx.timestamp = txObj.timestamp;
        if (txObj.signature) tx.signature = txObj.signature;
        if (txObj.publicKey) tx.publicKey = txObj.publicKey;
        return tx;
    }

    // 链完整性验证：校验 hash + previousHash 链式引用 + 交易签名 + nonce 递增
    isChainValid(chain, validateSignatures = true) {
        const bc = this.blockchain;
        const targetChain = chain || bc.chain;

        if (!targetChain || targetChain.length === 0) {
            return false;
        }

        // 如果是验证外来链，确保其创世块 hash 与本地一致（不同的创世块 = 不同的链）
        if (chain) {
            const incomingGenesisHash = targetChain[0].hash;
            const localGenesisHash = bc.chain[0].hash;
            if (incomingGenesisHash !== localGenesisHash) {
                this.log.error('创世块 hash 不一致', { received: incomingGenesisHash, local: localGenesisHash });
                return false;
            }
        }

        // 记录每个地址已确认的交易数（用于 nonce 递增验证）
        const nonceByAddress = new Map();

        for (let i = 1; i < targetChain.length; i++) {
            let currentBlock = targetChain[i];
            let previousBlock = targetChain[i - 1];

            // 重建 Block 实例（处理从 JSON 反序列化的情况）
            if (!(currentBlock instanceof Block)) {
                const b = currentBlock;
                const txSrc = b.transactions || (b.data ? b.data : []);
                currentBlock = new Block(b.index, b.timestamp, txSrc, b.previousHash);
                currentBlock.nonce = b.nonce;
                currentBlock.merkleRoot = b.merkleRoot || null;
                // 同时把原始 transactions 复制过来用于签名验证
                if (b.transactions && Array.isArray(b.transactions)) {
                    currentBlock.transactions = b.transactions;
                }
                // 使用 merkleRoot 重新计算 hash 以保持一致性
                if (currentBlock.merkleRoot) {
                    currentBlock.hash = currentBlock.calculateHash();
                } else {
                    currentBlock.hash = b.hash;
                }
            }
            if (!(previousBlock instanceof Block)) {
                const b = previousBlock;
                const txSrc = b.transactions || (b.data ? b.data : []);
                previousBlock = new Block(b.index, b.timestamp, txSrc, b.previousHash);
                previousBlock.nonce = b.nonce;
                previousBlock.merkleRoot = b.merkleRoot || null;
                if (b.transactions && Array.isArray(b.transactions)) {
                    previousBlock.transactions = b.transactions;
                }
                if (previousBlock.merkleRoot) {
                    previousBlock.hash = previousBlock.calculateHash();
                } else {
                    previousBlock.hash = b.hash;
                }
            }

            // 验证区块自身 hash
            const computedHash = currentBlock.calculateHash();
            if (currentBlock.hash !== computedHash) {
                if (chain) {
                    this.log.error('区块 hash 不一致', { index: currentBlock.index });
                }
                return false;
            }

            if (currentBlock.previousHash !== previousBlock.hash) {
                if (chain) {
                    this.log.error('区块 previousHash 不匹配', { index: currentBlock.index });
                }
                return false;
            }

            // ============================================
            // 验证区块中每笔交易的 ECDSA 签名 + nonce 顺序
            // ============================================
            if (currentBlock.transactions && Array.isArray(currentBlock.transactions)) {
                for (const tx of currentBlock.transactions) {
                    const txInstance = this._toTransactionInstance(tx);
                    if (!txInstance) continue;

                    // 1) ECDSA 签名验证（可选）
                    if (validateSignatures) {
                        if (!txInstance.isValid()) {
                            if (chain) {
                                this.log.error('交易签名验证失败', { blockIndex: currentBlock.index, txId: txInstance.id.substring(0, 12) });
                            } else {
                                this.log.error('交易签名验证失败', { blockIndex: currentBlock.index });
                            }
                            return false;
                        }
                    }

                    // 2) nonce 递增验证（防重放）：只对非 SYSTEM、非空 from 的交易验证
                    if (txInstance.from && txInstance.from !== '' && txInstance.from !== 'SYSTEM'
                        && txInstance.amount > 0) {
                        const sender = txInstance.from;
                        const expected = nonceByAddress.get(sender) || 0;
                        if (txInstance.nonce !== undefined && txInstance.nonce !== null) {
                            // 该交易携带 nonce → 必须严格等于 expected
                            if (Number(txInstance.nonce) !== expected) {
                                this.log.error('交易 nonce 不匹配', {
                                    blockIndex: currentBlock.index,
                                    sender: sender.substring(0, 12),
                                    expected,
                                    actual: txInstance.nonce
                                });
                                return false;
                            }
                        }
                        // 无论是否携带 nonce，计数都递增
                        nonceByAddress.set(sender, expected + 1);
                    }
                }
            }
        }
        return true;
    }

    // ============================================================
    // 自动检测并修复本地链
    // 从尾部向前扫描，找到第一个断裂点并截断
    // 返回被移除的区块（用于交易恢复）
    // ============================================================
    repairChain() {
        const bc = this.blockchain;
        const invalidIndex = this._findFirstInvalidIndex();
        if (invalidIndex === -1) {
            return []; // 链是有效的
        }

        const removedBlocks = bc.chain.splice(invalidIndex);
        bc.saveToFile();
        this.log.info('链已修复，已截断无效区块', { startIndex: invalidIndex, removedCount: removedBlocks.length });
        return removedBlocks;
    }

    // ============================================================
    // 从索引 1 开始扫描，返回第一个无效区块的索引；-1 表示全部有效
    // ============================================================
    _findFirstInvalidIndex() {
        const bc = this.blockchain;
        for (let i = 1; i < bc.chain.length; i++) {
            let currentBlock = bc.chain[i];
            let previousBlock = bc.chain[i - 1];

            // 重建 Block 实例（处理从 JSON 反序列化的情况）
            if (!(currentBlock instanceof Block)) {
                const b = currentBlock;
                const txSrc = b.transactions || (b.data ? b.data : []);
                currentBlock = new Block(b.index, b.timestamp, txSrc, b.previousHash);
                currentBlock.nonce = b.nonce;
                currentBlock.hash = b.hash;
                if (b.transactions && Array.isArray(b.transactions)) {
                    currentBlock.transactions = b.transactions;
                }
            }
            if (!(previousBlock instanceof Block)) {
                const b = previousBlock;
                const txSrc = b.transactions || (b.data ? b.data : []);
                previousBlock = new Block(b.index, b.timestamp, txSrc, b.previousHash);
                previousBlock.nonce = b.nonce;
                previousBlock.hash = b.hash;
                if (b.transactions && Array.isArray(b.transactions)) {
                    previousBlock.transactions = b.transactions;
                }
            }

            // 验证 hash
            if (currentBlock.hash !== currentBlock.calculateHash()) {
                this.log.warn('区块 hash 不一致，从此处截断', { blockIndex: i });
                return i;
            }
            // 验证 previousHash 链式引用
            if (currentBlock.previousHash !== previousBlock.hash) {
                this.log.warn('区块 previousHash 不匹配，从此处截断', { blockIndex: i });
                return i;
            }
        }
        return -1; // 全部有效
    }

    // 分叉处理 + 交易回滚：替换为更长的链
    replaceChain(newChain) {
        const bc = this.blockchain;

        if (newChain.length <= bc.chain.length) {
            this.log.warn('新链不更长，拒绝替换');
            return false;
        }
        if (!this.isChainValid(newChain)) {
            this.log.warn('新链验证失败，拒绝替换');
            return false;
        }

        // ---------------------------------------------------------
        // 分叉回滚：将旧链中"不在新链里"的用户交易放回交易池
        // ---------------------------------------------------------
        // 1. 收集新链中所有交易 id（用于判断哪些交易已经被别人打包了）
        const txIdsInNewChain = new Set();
        for (const block of newChain) {
            if (block.transactions && Array.isArray(block.transactions)) {
                for (const tx of block.transactions) {
                    if (tx.id) txIdsInNewChain.add(tx.id);
                }
            }
        }

        // 2. 扫描旧链，收集"用户真实交易"回滚到交易池
        //    - 排除挖矿奖励交易（from === 'SYSTEM'）→ 不放回交易池（否则会重复发放奖励）
        //      但会统计金额，因为链被整体替换后这些奖励"已自动作废"（余额是动态计算的）
        //    - 排除备注/创世交易（from === '' 或 !from）→ 不是用户交易
        //    - 排除新链中已有的交易（即已被别人打包的）→ 无需重复放入
        //    - 排除当前 pendingTransactions 中已有的交易 → 防重复
        const existingPendingIds = new Set(bc.pendingTransactions.map(t => t.id));
        const rollbackTx = [];

        // 用于日志确认：显式统计被回滚掉的矿工奖励总额
        let rollbackRewardCount = 0;
        let rollbackRewardAmount = 0;

        for (const block of bc.chain) {
            if (!block.transactions || !Array.isArray(block.transactions)) continue;
            for (const tx of block.transactions) {
                // 挖矿奖励：统计但不放回交易池（链被替换后奖励自动作废）
                if (tx.from === 'SYSTEM') {
                    if (!txIdsInNewChain.has(tx.id)) {
                        rollbackRewardCount++;
                        rollbackRewardAmount += Number(tx.amount) || 0;
                    }
                    continue;
                }
                if (!tx.from || tx.from === '') continue;
                if (txIdsInNewChain.has(tx.id)) continue;
                if (existingPendingIds.has(tx.id)) continue;
                // 构造一个干净的 Transaction 对象放回交易池
                rollbackTx.push({
                    id: tx.id,
                    from: tx.from,
                    to: tx.to,
                    amount: Number(tx.amount),
                    fee: Number(tx.fee) || 0,
                    note: tx.note || '',
                    timestamp: tx.timestamp,
                    signature: tx.signature
                });
            }
        }

        if (rollbackTx.length > 0) {
            // 加到 pendingTransactions 头部，让回滚交易优先被重新打包
            bc.pendingTransactions = rollbackTx.concat(bc.pendingTransactions);
            this.log.info('分叉回滚：已将用户交易放回交易池', { count: rollbackTx.length });
        }
        if (rollbackRewardCount > 0) {
            this.log.info('旧链上的矿工奖励已作废', { blocks: rollbackRewardCount, totalAmount: rollbackRewardAmount });
        }

        // ---------------------------------------------------------
        // 正式替换链
        // ---------------------------------------------------------
        bc.chain = newChain.map((b) => {
            if (b instanceof Block) return b;
            const txSrc = b.transactions || (b.data ? b.data : []);
            const block = new Block(b.index, b.timestamp, txSrc, b.previousHash);
            block.nonce = b.nonce;
            block.hash = b.hash;
            block.merkleRoot = b.merkleRoot || null;  // ★ 修复：保留原始 merkleRoot，防止 hash 校验失败
            return block;
        });

        // 🧹 清理交易池：移除新链中已打包的交易（防止同一笔交易被其他节点再次打包）
        const pendingBefore = bc.pendingTransactions.length;
        // txIdsInNewChain 已在前面回滚逻辑中计算好，直接复用
        if (txIdsInNewChain.size > 0) {
            bc.pendingTransactions = bc.pendingTransactions.filter(t => !txIdsInNewChain.has(t.id));
            const removed = pendingBefore - bc.pendingTransactions.length;
            if (removed > 0) {
                this.log.info('交易池清理', { removed, context: 'replaceChain' });
            }
        }

        // 根据新链的区块时间戳重新计算难度，保证所有节点难度一致
        bc.recalculateDifficulty();
        bc.saveToFile();
        this.log.info('链已替换', { newLength: bc.chain.length, rollbackCount: rollbackTx.length, difficulty: bc.difficulty });
        return true;
    }
}

module.exports = { ChainSync };