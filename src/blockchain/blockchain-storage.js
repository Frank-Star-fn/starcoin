const fs = require('fs');
const { Block, Transaction } = require('../core');
const config = require('../config');

/**
 * 持久化管理器：负责链数据的文件读写与恢复
 * 所有与文件系统相关的操作都集中在这里
 *
 * 通过 this.blockchain 反向引用访问：
 *   this.blockchain.chain                    → 区块数组
 *   this.blockchain.dataFile                 → 数据文件路径
 *   this.blockchain.difficulty               → 当前难度（读写）
 *   this.blockchain.difficultyHistory        → 难度历史（读写）
 *   this.blockchain.lastAdjustmentBlock      → 上次调整区块（读写）
 *   this.blockchain.isChainValid()           → 链完整性验证
 *   this.blockchain.recalculateDifficulty()  → 重新计算难度
 *   this.blockchain.createGenesisBlock()     → 创建创世块
 */
class StorageManager {
    constructor(blockchain) {
        this.blockchain = blockchain;
    }

    loadFromFile() {
        // testMode 下不读写磁盘
        if (this.blockchain.testMode) { return false; }
        try {
            if (fs.existsSync(this.blockchain.dataFile)) {
                const raw = fs.readFileSync(this.blockchain.dataFile, 'utf8');
                const saved = JSON.parse(raw);
                if (saved && saved.chain && saved.chain.length > 0) {
                    // ----- 恢复难度数据（兼容旧格式，但最终以链上时间戳为准） -----
                    if (saved.difficulty != null) {
                        this.blockchain.difficulty = saved.difficulty;
                    }
                    if (saved.difficultyHistory) {
                        this.blockchain.difficultyHistory = saved.difficultyHistory;
                    }
                    // blockMiningTimes 已废弃，不再从文件加载
                    if (saved.lastAdjustmentBlock != null) {
                        this.blockchain.lastAdjustmentBlock = saved.lastAdjustmentBlock;
                    }

                    // 从保存数据重建区块对象 (支持 data 旧格式和 transactions 新格式)
                    // 注意：从 JSON 读取的 transactions 是普通对象，保留它们供签名验证使用
                    const rebuiltChain = saved.chain.map(b => {
                        const block = new Block(b.index, b.timestamp, [], b.previousHash);
                        block.nonce = b.nonce;
                        block.merkleRoot = b.merkleRoot || null;  // 恢复 merkleRoot（旧数据为 null，兼容旧链）
                        // 保留原始 transactions 数组（包含 signature/publicKey 等字段）
                        if (b.transactions && Array.isArray(b.transactions)) {
                            block.transactions = b.transactions;
                        } else if (b.data) {
                            // 旧格式 data 字段：Block 构造函数已经帮我们派生 transactions
                            const blockWithData = new Block(b.index, b.timestamp, b.data, b.previousHash);
                            block.transactions = blockWithData.transactions;
                        }
                        // 恢复 hash：如果有 merkleRoot，确保 hash 与 merkleRoot 一致
                        if (block.merkleRoot) {
                            block.hash = block.calculateHash();
                        } else {
                            block.hash = b.hash;
                        }
                        return block;
                    });
                    const tempChain = this.blockchain.chain;
                    this.blockchain.chain = rebuiltChain;

                    // 第一级：严格验证（区块 hash + 交易签名）
                    if (this.blockchain.isChainValid(undefined, true)) {
                        // 加载成功后，根据链上区块时间戳重新计算难度，保证所有节点一致
                        this.blockchain.recalculateDifficulty();
                        console.log(`📂 已从本地文件加载区块链: ${this.blockchain.dataFile} (${rebuiltChain.length} 个区块, 难度=${this.blockchain.difficulty}) ✓`);
                        return true;
                    }

                    // 第二级：降级验证（仅区块 hash，兼容旧数据格式）
                    if (this.blockchain.isChainValid(undefined, false)) {
                        // 加载成功后，根据链上区块时间戳重新计算难度
                        this.blockchain.recalculateDifficulty();
                        console.log(`⚠️  [兼容模式] 本地链使用旧签名格式（非 ECDSA），区块结构有效但签名未验证`);
                        console.log(`📂 已从本地文件加载区块链: ${this.blockchain.dataFile} (${rebuiltChain.length} 个区块, 难度=${this.blockchain.difficulty})`);
                        return true;
                    }

                    // 两级验证都失败
                    console.log('❌  本地文件中的区块链无效，恢复为创世区块');
                    this.blockchain.chain = tempChain;
                    return false;
                } else {
                    console.log('⚠️  本地文件格式无效，已重置为创世区块');
                    return false;
                }
            } else {
                console.log(`📂 未找到本地文件，创建新链: ${this.blockchain.dataFile}`);
                return false;
            }
        } catch (err) {
            console.error('❌ 从文件加载失败:', err.message);
            this.blockchain.chain = [this.blockchain.createGenesisBlock()];
            return false;
        }
    }

    saveToFile() {
        // testMode 下不读写磁盘
        if (this.blockchain.testMode) { return true; }
        try {
            const data = {
                chain: this.blockchain.chain,
                difficulty: this.blockchain.difficulty,
                difficultyHistory: this.blockchain.difficultyHistory,
                // blockMiningTimes 已废弃（改用链上时间戳），不再持久化
                lastAdjustmentBlock: this.blockchain.lastAdjustmentBlock,
                savedAt: new Date().toISOString(),
                version: '3.0'
            };
            fs.writeFileSync(this.blockchain.dataFile, JSON.stringify(data, null, 2), 'utf8');
            return true;
        } catch (err) {
            console.error('❌ 保存到文件失败:', err.message);
            return false;
        }
    }

    clearDataFile() {
        try {
            // testMode 下仅跳过文件删除，内存状态仍需重置
            if (!this.blockchain.testMode) {
                if (fs.existsSync(this.blockchain.dataFile)) {
                    fs.unlinkSync(this.blockchain.dataFile);
                }
            }
            this.blockchain.chain = [this.blockchain.createGenesisBlock()];
            this.blockchain.difficulty = config.DIFFICULTY_INITIAL;
            this.blockchain.lastAdjustmentBlock = 0;
            this.blockchain.difficultyHistory = [];
            return true;
        } catch (err) {
            console.error('❌ 清除文件失败:', err.message);
            return false;
        }
    }
}

module.exports = { StorageManager };