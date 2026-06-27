const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Block, Transaction, generateWallet, importWalletFromPrivateKey } = require('./core');
const { ChainSync } = require('./chain-sync');
const { DifficultyManager } = require('./difficulty-manager');

class Blockchain {
    constructor(portOverride) {
        const PORT = process.env.PORT || 3000;
        this.diffManager = new DifficultyManager({
            targetBlockTime: 12,
            difficultyAdjustInterval: 6,
            difficultyMin: 3,
            difficultyMax: 12,
            difficultyStep: 0.1
        });
        this.pendingTransactions = [];  // 交易池 (Mempool)
        this.miningReward = 50;          // 挖矿奖励
        this.coinbaseMaturity = 5;       // 矿工奖励锁定期（块数），成熟后才能使用
        this.miningAddress = 'MINER_' + (portOverride || PORT);
        this.chain = [this.createGenesisBlock()]; // 先初始化创世区块
        this.dataFile = path.join(__dirname, '..', 'data', `blockchain_${portOverride || PORT}.json`);
        this.sync = new ChainSync(this); // 必须在 loadFromFile 前初始化（isChainValid 委托给 sync）
        // freshStart: 是否未从本地加载到数据（全新节点），用于启动时优先从其他节点同步
        this.freshStart = !this.loadFromFile();
    }

    // ============================================================
    //  难度属性代理：委托给 this.diffManager（保持外部兼容）
    // ============================================================
    get difficulty() { return this.diffManager.difficulty; }
    set difficulty(val) { this.diffManager.difficulty = val; }
    get difficultyHistory() { return this.diffManager.difficultyHistory; }
    set difficultyHistory(val) { this.diffManager.difficultyHistory = val; }
    get targetBlockTime() { return this.diffManager.targetBlockTime; }
    get difficultyAdjustInterval() { return this.diffManager.difficultyAdjustInterval; }
    get difficultyMin() { return this.diffManager.difficultyMin; }
    get difficultyMax() { return this.diffManager.difficultyMax; }
    get difficultyStep() { return this.diffManager.difficultyStep; }
    get lastAdjustmentBlock() { return this.diffManager.lastAdjustmentBlock; }
    set lastAdjustmentBlock(val) { this.diffManager.lastAdjustmentBlock = val; }

    createGenesisBlock() {
        // 关键：创世区块必须使用旧格式 { data: '创世区块...' }
        // 这样旧节点、新节点、旧 blockchain.json 文件的创世区块 hash 完全一致
        // Block 构造函数会自动派生 transactions 数组用于显示/遍历
        //
        // ⚠️ 重要：Transaction 构造函数 id = hash(... + Date.now() + Math.random())
        // 会导致每次创建相同交易都得到不同 id → 不同 merkleRoot → 不同 block hash。
        // 因此必须覆盖 genesis tx 的 id 为确定性值，以确保所有节点创世块 hash 一致。
        const block = new Block(0, '2025-01-01T00:00:00.000Z',
            { data: '创世区块：StarCoin诞生！' }, '0');
        if (block.transactions && block.transactions.length > 0) {
            // 使用内容的确定性 hash 作为 id，确保所有节点一致
            block.transactions[0].id = crypto.createHash('sha256')
                .update('genesis:' + block.transactions[0].from + block.transactions[0].to +
                        block.transactions[0].amount + block.transactions[0].note)
                .digest('hex');
            block.transactions[0].timestamp = '2025-01-01T00:00:00.000Z';
            // 重新计算 merkleRoot 和 block hash
            block.updateMerkleRoot();
            block.hash = block.calculateHash();
        }
        return block;
    }

    // 添加交易到交易池
    addTransaction(tx) {
        // 校验基本字段
        if (!tx.from || !tx.to || tx.amount <= 0) {
            throw new Error('交易必须包含 from, to, 和正数 amount');
        }
        if (tx.from === tx.to) {
            throw new Error('不能给自己转账');
        }

        // 构建完整的 Transaction 对象（如果传入的是普通 JSON 对象）
        let transaction;
        if (tx instanceof Transaction) {
            transaction = tx;
        } else {
            transaction = new Transaction(tx.from, tx.to, tx.amount, tx.fee || 0, tx.note || '');
            // 如果传入对象包含签名和公钥，复制过来
            if (tx.signature) transaction.signature = tx.signature;
            if (tx.publicKey) transaction.publicKey = tx.publicKey;
            if (tx.timestamp) transaction.timestamp = tx.timestamp;
            if (tx.id) transaction.id = tx.id;
        }

        // ECDSA 签名验证（核心安全检查）
        if (!transaction.isValid()) {
            throw new Error('交易签名验证失败！可能是未签名、签名被篡改，或公钥与地址不匹配');
        }

        // 检查余额（必须把交易池中待打包的出账金额一起扣除，否则可连点多笔导致超额）
        const senderBalance = this.getBalance(transaction.from);
        const pendingOutgoing = this.pendingTransactions
            .filter(t => t.from === transaction.from)
            .reduce((sum, t) => sum + (Number(t.amount) || 0) + (Number(t.fee) || 0), 0);
        const availableBalance = senderBalance - pendingOutgoing;

        if (availableBalance < transaction.amount + transaction.fee) {
            throw new Error(
                `余额不足！已确认余额: ${senderBalance}, ` +
                `交易池中待打包出账: ${pendingOutgoing}, ` +
                `可用余额: ${availableBalance}, ` +
                `当前转账所需: ${transaction.amount + transaction.fee}`
            );
        }

        this.pendingTransactions.push(transaction);
        return transaction;
    }

    // 从交易池挖矿，打包交易到新区块
    mineBlock(minerAddress, blockDataText) {
        // 准备要打包的交易：按手续费降序排序，优先打包手续费最高的交易
        const sortedTxs = [...this.pendingTransactions].sort((a, b) => (b.fee || 0) - (a.fee || 0));
        const txsToInclude = sortedTxs.slice(0, 100); // 最多100笔/区块
        // 如果没有交易，也允许只写一条备注文本（兼容旧接口）
        if (blockDataText && blockDataText.trim()) {
            txsToInclude.push(new Transaction('', 'NOTE', 0, 0, blockDataText.trim()));
        }
        // ⚠️ 注意：即使 txsToInclude 为空数组也允许挖矿
        // 因为挖矿奖励交易（rewardTx）会被添加，区块至少包含一笔奖励交易
        // 添加挖矿奖励交易（系统发给矿工）
        const rewardTx = new Transaction(
            'SYSTEM',
            minerAddress || this.miningAddress,
            this.miningReward,
            0,
            'Miner Reward'
        );
        txsToInclude.unshift(rewardTx);  // 奖励交易放在区块第一笔

        // 构建新区块
        const block = new Block(
            this.chain.length,
            new Date().toISOString(),
            txsToInclude,
            this.getLatestBlock().hash
        );
        block.mineBlock(this.difficulty);

        // 打包后清空这些交易
        const txIdsInBlock = txsToInclude.map(t => t.id);
        this.pendingTransactions = this.pendingTransactions.filter(t => !txIdsInBlock.includes(t.id));

        this.chain.push(block);
        // 使用链上区块时间戳调整难度，确保所有节点难度一致
        this.adjustDifficulty();
        this.saveToFile();
        return block;
    }

    // 异步挖矿（带进度回调，用于前端可视化）
    async mineBlockAsync(minerAddress, blockDataText, onProgress) {
        // 按手续费降序排序，优先打包手续费最高的交易
        const sortedTxs = [...this.pendingTransactions].sort((a, b) => (b.fee || 0) - (a.fee || 0));
        const txsToInclude = sortedTxs.slice(0, 100);
        if (blockDataText && blockDataText.trim()) {
            txsToInclude.push(new Transaction('', 'NOTE', 0, 0, blockDataText.trim()));
        }
        const rewardTx = new Transaction(
            'SYSTEM',
            minerAddress || this.miningAddress,
            this.miningReward,
            0,
            'Miner Reward'
        );
        txsToInclude.unshift(rewardTx);

        // 记录挖矿开始时的链尾 hash，用于检测挖矿过程中链是否被外部更新
        const startingLatestHash = this.getLatestBlock().hash;

        const block = new Block(
            this.chain.length,
            new Date().toISOString(),
            txsToInclude,
            startingLatestHash
        );

        // 创建 shouldAbort 函数：当链尾 hash 与开始时不一致，说明链被外部更新了
        const shouldAbort = () => {
            return this.getLatestBlock().hash !== startingLatestHash;
        };

        // 异步挖矿（让步事件循环，让进度能实时推送）
        // 传入 shouldAbort，让 block.mineBlockAsync 在检测到链变化时提前中止
        const mineResult = await block.mineBlockAsync(this.difficulty, onProgress, 5000, shouldAbort);

        // 如果挖矿被中止（链已更新），则丢弃当前区块，交易留在交易池，等调用者重新开始
        if (mineResult && mineResult.aborted) {
            console.log('🔄 [异步挖矿] 检测到链已更新，中止当前挖矿，等待在新链上重新开始');
            return { canceled: true, reason: mineResult.reason };
        }

        const txIdsInBlock = txsToInclude.map(t => t.id);
        this.pendingTransactions = this.pendingTransactions.filter(t => !txIdsInBlock.includes(t.id));

        this.chain.push(block);
        // 使用链上区块时间戳调整难度，确保所有节点难度一致
        this.adjustDifficulty();

        // 异步挖矿期间可能收到 P2P 区块导致链状态变化，验证并自动修复
        if (!this.isChainValid()) {
            console.warn('⚠️ [异步挖矿] 链可能已被其他节点更新，自动修复中...');
            const removed = this.repairChain();
            // 把被截断区块中的用户交易放回交易池（排除 SYSTEM 奖励交易和空交易）
            const existingPendingIds = new Set(this.pendingTransactions.map(t => t.id));
            for (const rb of removed) {
                if (!rb.transactions || !Array.isArray(rb.transactions)) continue;
                for (const tx of rb.transactions) {
                    if (!tx.from || tx.from === 'SYSTEM' || tx.from === '') continue;
                    if (existingPendingIds.has(tx.id)) continue;
                    this.pendingTransactions.unshift(tx);
                    existingPendingIds.add(tx.id);
                }
            }
            this.saveToFile();
            console.log(`✅ [异步挖矿] 修复完成，当前链长度: ${this.chain.length}`);
        } else {
            this.saveToFile();
        }
        return block;
    }

    // 判断一笔矿工奖励（coinbase）是否已成熟（达到锁定期确认数）
    _isCoinbaseMature(blockIndex) {
        // 奖励所在区块索引 + 成熟期 <= 当前链尾索引，才算成熟
        return blockIndex + this.coinbaseMaturity <= this.getLatestBlock().index;
    }

    // 动态难度调整（委托给 DifficultyManager）
    adjustDifficulty() {
        this.diffManager.adjustDifficulty(this.chain, this.getLatestBlock().index);
    }

    // 根据链上区块时间戳重新计算难度（用于 P2P 链替换后保持所有节点难度一致）
    // 委托给 DifficultyManager
    recalculateDifficulty() {
        this.diffManager.recalculateDifficulty(this.chain);
    }

    // 计算指定地址的余额（遍历整个链）
    // @param includeImmature 是否包含未成熟的矿工奖励（缺省 false，仅返回可用余额）
    getBalance(address, includeImmature = false) {
        if (!address) return 0;
        let balance = 0;
        const latestIndex = this.getLatestBlock().index;
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.from === address) {
                    balance -= tx.amount;
                    balance -= tx.fee;
                }
                if (tx.to === address) {
                    // 矿工奖励：检查锁定期
                    if (tx.from === 'SYSTEM' && !includeImmature) {
                        if (!this._isCoinbaseMature(block.index)) {
                            continue; // 奖励未成熟，不计入可用余额
                        }
                    }
                    balance += tx.amount;
                }
            }
        }
        return balance;
    }

    // 获取地址的"锁定奖励"金额（未成熟的矿工奖励总额）
    getLockedRewards(address) {
        if (!address) return 0;
        let locked = 0;
        const latestIndex = this.getLatestBlock().index;
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.to === address && tx.from === 'SYSTEM') {
                    if (!this._isCoinbaseMature(block.index)) {
                        locked += Number(tx.amount) || 0;
                    }
                }
            }
        }
        return locked;
    }

    // 获取地址的所有交易历史
    getTransactionHistory(address) {
        if (!address) return [];
        const history = [];
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.from === address || tx.to === address) {
                    history.push({
                        ...tx,
                        blockIndex: block.index,
                        blockHash: block.hash,
                        direction: tx.from === address ? 'OUT' : 'IN'
                    });
                }
            }
        }
        return history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    // 计算全链总燃烧手续费（所有交易的 fee 总和）
    getTotalBurnedFees() {
        let totalFees = 0;
        for (const block of this.chain) {
            if (!block.transactions || !Array.isArray(block.transactions)) continue;
            for (const tx of block.transactions) {
                totalFees += Number(tx.fee) || 0;
            }
        }
        return totalFees;
    }

    // 获取最新 N 个区块的燃烧手续费详情（用于前端图表展示）
    getRecentBurnedFees(count = 20) {
        const result = [];
        const startIdx = Math.max(0, this.chain.length - count);
        for (let i = startIdx; i < this.chain.length; i++) {
            const block = this.chain[i];
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

    // 获取所有地址及其余额（用于排名展示）
    getAllAddresses() {
        const map = new Map();
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.from) map.set(tx.from, (map.get(tx.from) || 0));
                if (tx.to) map.set(tx.to, (map.get(tx.to) || 0));
            }
        }
        const result = [];
        for (const addr of map.keys()) {
            result.push({
                address: addr,
                balance: this.getBalance(addr),
                lockedRewards: this.getLockedRewards(addr),
                txCount: this.getTransactionHistory(addr).length
            });
        }
        return result.sort((a, b) => b.balance - a.balance);
    }

    loadFromFile() {
        try {
            if (fs.existsSync(this.dataFile)) {
                const raw = fs.readFileSync(this.dataFile, 'utf8');
                const saved = JSON.parse(raw);
                if (saved && saved.chain && saved.chain.length > 0) {
                    // ----- 恢复难度数据（兼容旧格式，但最终以链上时间戳为准） -----
                    if (saved.difficulty != null) {
                        this.difficulty = saved.difficulty;
                    }
                    if (saved.difficultyHistory) {
                        this.difficultyHistory = saved.difficultyHistory;
                    }
                    // blockMiningTimes 已废弃，不再从文件加载
                    if (saved.lastAdjustmentBlock != null) {
                        this.lastAdjustmentBlock = saved.lastAdjustmentBlock;
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
                    const tempChain = this.chain;
                    this.chain = rebuiltChain;

                    // 第一级：严格验证（区块 hash + 交易签名）
                    if (this.isChainValid(undefined, true)) {
                        // 加载成功后，根据链上区块时间戳重新计算难度，保证所有节点一致
                        this.recalculateDifficulty();
                        console.log(`📂 已从本地文件加载区块链: ${this.dataFile} (${rebuiltChain.length} 个区块, 难度=${this.difficulty}) ✓`);
                        return true;
                    }

                    // 第二级：降级验证（仅区块 hash，兼容旧数据格式）
                    if (this.isChainValid(undefined, false)) {
                        // 加载成功后，根据链上区块时间戳重新计算难度
                        this.recalculateDifficulty();
                        console.log(`⚠️  [兼容模式] 本地链使用旧签名格式（非 ECDSA），区块结构有效但签名未验证`);
                        console.log(`📂 已从本地文件加载区块链: ${this.dataFile} (${rebuiltChain.length} 个区块, 难度=${this.difficulty})`);
                        return true;
                    }

                    // 两级验证都失败
                    console.log('❌  本地文件中的区块链无效，恢复为创世区块');
                    this.chain = tempChain;
                    return false;
                } else {
                    console.log('⚠️  本地文件格式无效，已重置为创世区块');
                    return false;
                }
            } else {
                console.log(`📂 未找到本地文件，创建新链: ${this.dataFile}`);
                return false;
            }
        } catch (err) {
            console.error('❌ 从文件加载失败:', err.message);
            this.chain = [this.createGenesisBlock()];
            return false;
        }
    }

    saveToFile() {
        try {
            const data = {
                chain: this.chain,
                difficulty: this.difficulty,
                difficultyHistory: this.difficultyHistory,
                // blockMiningTimes 已废弃（改用链上时间戳），不再持久化
                lastAdjustmentBlock: this.lastAdjustmentBlock,
                savedAt: new Date().toISOString(),
                version: '3.0'
            };
            fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2), 'utf8');
            return true;
        } catch (err) {
            console.error('❌ 保存到文件失败:', err.message);
            return false;
        }
    }

    clearDataFile() {
        try {
            if (fs.existsSync(this.dataFile)) {
                fs.unlinkSync(this.dataFile);
            }
            this.chain = [this.createGenesisBlock()];
            this.difficulty = 5;
            this.lastAdjustmentBlock = 0;
            this.difficultyHistory = [];
            return true;
        } catch (err) {
            console.error('❌ 清除文件失败:', err.message);
            return false;
        }
    }

    getLatestBlock() {
        return this.chain[this.chain.length - 1];
    }

    addBlock(newBlock) {
        let block = newBlock;
        if (!(newBlock instanceof Block)) {
            const txSource = newBlock.transactions || (newBlock.data ? newBlock.data : []);
            block = new Block(newBlock.index, newBlock.timestamp, txSource, newBlock.previousHash);
            block.nonce = newBlock.nonce;
            block.hash = newBlock.hash;
        }
        if (block.hash !== block.calculateHash()) {
            return null;
        }
        this.chain.push(block);
        // P2P 接收区块后也用链上时间戳调整难度，确保全网一致
        this.adjustDifficulty();
        this.saveToFile();
        return block;
    }

    // ============================================================
    //  委托方法：链验证、修复、替换 → 转发给 this.sync (ChainSync)
    // ============================================================

    // 链完整性验证（委托）
    isChainValid(chain, validateSignatures = true) {
        return this.sync.isChainValid(chain, validateSignatures);
    }

    // 自动修复本地链（委托）
    repairChain() {
        return this.sync.repairChain();
    }

    // 分叉替换（委托）
    replaceChain(newChain) {
        return this.sync.replaceChain(newChain);
    }
}

module.exports = { Blockchain, Block, Transaction, generateWallet, importWalletFromPrivateKey };