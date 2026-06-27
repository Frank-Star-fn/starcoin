const path = require('path');
const fs = require('fs');
const { Block, Transaction, generateWallet } = require('./core');

class Blockchain {
    constructor(portOverride) {
        const PORT = process.env.PORT || 3000;
        this.difficulty = 5;               // 当前挖矿难度（支持小数，例如 5.5 = 5个零 + 下字节≤0x7f）
        this.difficultyHistory = [];        // 难度变更历史 [{blockIndex, difficulty, avgTime, reason}]
        this.targetBlockTime = 12;          // 目标出块时间（秒）
        this.difficultyAdjustInterval = 6;  // 每 N 个区块调整一次难度
        this.difficultyMin = 3;             // 最小难度
        this.difficultyMax = 12;            // 最大难度
        this.difficultyStep = 0.1;          // 每次难度调整的步长（越小越平滑；0.1=约 1.3x 工作量变化）
        this.lastAdjustmentBlock = 0;       // 上次调整时的区块高度
        this.blockMiningTimes = {};         // { blockIndex: miningTimeSeconds }
        this.pendingTransactions = [];  // 交易池 (Mempool)
        this.miningReward = 50;          // 挖矿奖励
        this.coinbaseMaturity = 5;       // 矿工奖励锁定期（块数），成熟后才能使用
        this.miningAddress = 'MINER_' + (portOverride || PORT);
        this.chain = [this.createGenesisBlock()]; // 先初始化创世区块
        this.dataFile = path.join(__dirname, '..', 'data', `blockchain_${portOverride || PORT}.json`);
        this.loadFromFile();
    }

    createGenesisBlock() {
        // 关键：创世区块必须使用旧格式 { data: '创世区块...' }
        // 这样旧节点、新节点、旧 blockchain.json 文件的创世区块 hash 完全一致
        // Block 构造函数会自动派生 transactions 数组用于显示/遍历
        return new Block(0, '2025-01-01T00:00:00.000Z',
            { data: '创世区块：StarCoin诞生！' }, '0');
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
        const startTime = Date.now();
        // 准备要打包的交易
        const txsToInclude = this.pendingTransactions.slice(0, 100); // 最多100笔/区块
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
        this.recordMiningTime(block.index, (Date.now() - startTime) / 1000);
        this.adjustDifficulty();
        this.saveToFile();
        return block;
    }

    // 异步挖矿（带进度回调，用于前端可视化）
    async mineBlockAsync(minerAddress, blockDataText, onProgress) {
        const startTime = Date.now();
        const txsToInclude = this.pendingTransactions.slice(0, 100);
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

        const block = new Block(
            this.chain.length,
            new Date().toISOString(),
            txsToInclude,
            this.getLatestBlock().hash
        );

        // 异步挖矿（让步事件循环，让进度能实时推送）
        await block.mineBlockAsync(this.difficulty, onProgress);

        const txIdsInBlock = txsToInclude.map(t => t.id);
        this.pendingTransactions = this.pendingTransactions.filter(t => !txIdsInBlock.includes(t.id));

        this.chain.push(block);
        this.recordMiningTime(block.index, (Date.now() - startTime) / 1000);
        this.adjustDifficulty();
        this.saveToFile();
        return block;
    }

    // 判断一笔矿工奖励（coinbase）是否已成熟（达到锁定期确认数）
    _isCoinbaseMature(blockIndex) {
        // 奖励所在区块索引 + 成熟期 <= 当前链尾索引，才算成熟
        return blockIndex + this.coinbaseMaturity <= this.getLatestBlock().index;
    }

    // 记录区块挖矿耗时（用于难度调整）
    recordMiningTime(blockIndex, timeSeconds) {
        this.blockMiningTimes[blockIndex] = timeSeconds;
    }

    // 动态难度调整：每 N 个区块，根据最近出块速度调整难度
    adjustDifficulty() {
        const latestIndex = this.getLatestBlock().index;

        // 从创世块之后才开始调整
        if (latestIndex < 2) return;

        // 检查是否需要调整（每 difficultyAdjustInterval 个区块调整一次）
        const blocksSinceLastAdjust = latestIndex - this.lastAdjustmentBlock;
        if (blocksSinceLastAdjust < this.difficultyAdjustInterval) return;

        // 获取最近 N 个区块的平均挖矿时间
        let totalTime = 0;
        let count = 0;
        const startIdx = Math.max(1, latestIndex - this.difficultyAdjustInterval + 1);
        for (let i = startIdx; i <= latestIndex; i++) {
            if (this.blockMiningTimes[i] != null) {
                totalTime += this.blockMiningTimes[i];
                count++;
            }
        }

        if (count < 2) return; // 数据不足，暂不调整

        const avgTime = totalTime / count;
        const oldDifficulty = this.difficulty;

        // ---- 难度调整算法（平滑浮点版） ----
        // 根据 (avgTime / targetTime) 比例计算难度变化量，以 difficultyStep 为步长
        //   ratio > 1 → 出块偏慢 → 降低难度
        //   ratio < 1 → 出块偏快 → 升高难度
        // 思路：ratio 的 log2 大致对应难度应变化的"整数位数"，再映射为步长变化
        const ratio = avgTime / this.targetBlockTime;
        // 为避免震荡，只在 ratio 偏离 1 较远时才调整（死区 10% 内不调）
        let delta = 0;
        if (ratio > 1.15) {
            // 出块偏慢：降低难度（ratio=2 → -step；ratio=4 → -2step；用 log2 平滑）
            delta = -this.difficultyStep * Math.min(3, Math.max(1, Math.round(Math.log2(ratio))));
        } else if (ratio < 0.85) {
            // 出块偏快：升高难度
            delta = +this.difficultyStep * Math.min(3, Math.max(1, Math.round(-Math.log2(ratio))));
        }

        if (delta !== 0) {
            const raw = this.difficulty + delta;
            // 钳位到 [difficultyMin, difficultyMax]，并保留 1 位小数避免浮点误差
            this.difficulty = Math.max(
                this.difficultyMin,
                Math.min(this.difficultyMax, Math.round(raw * 10) / 10)
            );
        }

        // 记录难度变更历史
        if (this.difficulty !== oldDifficulty) {
            this.difficultyHistory.push({
                blockIndex: latestIndex,
                oldDifficulty: oldDifficulty,
                newDifficulty: this.difficulty,
                avgTime: Math.round(avgTime * 10) / 10,
                targetTime: this.targetBlockTime,
                reason: avgTime > this.targetBlockTime * 1.3 ? '出块偏慢 ↓' : '出块偏快 ↑'
            });
            console.log(
                `⚙️ 难度调整 [区块 #${latestIndex}]: ${oldDifficulty} → ${this.difficulty} ` +
                `(平均 ${avgTime.toFixed(1)}s/块, 目标 ${this.targetBlockTime}s/块)`
            );
        } else {
            console.log(
                `📊 难度评估 [区块 #${latestIndex}]: 维持 ${this.difficulty} ` +
                `(平均 ${avgTime.toFixed(1)}s/块, 目标 ${this.targetBlockTime}s/块)`
            );
        }

        this.lastAdjustmentBlock = latestIndex;
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
                    // ----- 恢复难度数据 -----
                    if (saved.difficulty != null) {
                        this.difficulty = saved.difficulty;
                    }
                    if (saved.difficultyHistory) {
                        this.difficultyHistory = saved.difficultyHistory;
                    }
                    if (saved.blockMiningTimes) {
                        this.blockMiningTimes = saved.blockMiningTimes;
                    }
                    if (saved.lastAdjustmentBlock != null) {
                        this.lastAdjustmentBlock = saved.lastAdjustmentBlock;
                    }

                    // 从保存数据重建区块对象 (支持 data 旧格式和 transactions 新格式)
                    // 注意：从 JSON 读取的 transactions 是普通对象，保留它们供签名验证使用
                    const rebuiltChain = saved.chain.map(b => {
                        const block = new Block(b.index, b.timestamp, [], b.previousHash);
                        block.nonce = b.nonce;
                        block.hash = b.hash;
                        // 保留原始 transactions 数组（包含 signature/publicKey 等字段）
                        if (b.transactions && Array.isArray(b.transactions)) {
                            block.transactions = b.transactions;
                        } else if (b.data) {
                            // 旧格式 data 字段：Block 构造函数已经帮我们派生 transactions
                            const blockWithData = new Block(b.index, b.timestamp, b.data, b.previousHash);
                            block.transactions = blockWithData.transactions;
                        }
                        return block;
                    });
                    const tempChain = this.chain;
                    this.chain = rebuiltChain;

                    // 第一级：严格验证（区块 hash + 交易签名）
                    if (this.isChainValid(undefined, true)) {
                        console.log(`📂 已从本地文件加载区块链: ${this.dataFile} (${rebuiltChain.length} 个区块, 难度=${this.difficulty}) ✓`);
                        return true;
                    }

                    // 第二级：降级验证（仅区块 hash，兼容旧数据格式）
                    if (this.isChainValid(undefined, false)) {
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
                blockMiningTimes: this.blockMiningTimes,
                lastAdjustmentBlock: this.lastAdjustmentBlock,
                savedAt: new Date().toISOString(),
                version: '2.0'
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
        this.saveToFile();
        return block;
    }

    // 辅助：把普通 JSON 对象转换为 Transaction 实例（用于签名验证）
    _toTransactionInstance(txObj) {
        if (!txObj) return null;
        // 如果已经是 Transaction 实例，直接返回
        if (txObj instanceof Transaction) return txObj;
        // 从普通对象还原
        const tx = new Transaction(txObj.from, txObj.to, txObj.amount, txObj.fee || 0, txObj.note || '');
        if (txObj.id) tx.id = txObj.id;
        if (txObj.timestamp) tx.timestamp = txObj.timestamp;
        if (txObj.signature) tx.signature = txObj.signature;
        if (txObj.publicKey) tx.publicKey = txObj.publicKey;
        return tx;
    }

    // chain: 要验证的链（不传则验证自身）
    // validateSignatures: 是否验证每笔交易的 ECDSA 签名（默认 true；旧数据可设为 false 兼容）
    isChainValid(chain, validateSignatures = true) {
        const targetChain = chain || this.chain;

        if (!targetChain || targetChain.length === 0) {
            return false;
        }

        // 如果是验证外来链，确保其创世块 hash 与本地一致（不同的创世块 = 不同的链）
        if (chain) {
            const incomingGenesisHash = targetChain[0].hash;
            const localGenesisHash = this.chain[0].hash;
            if (incomingGenesisHash !== localGenesisHash) {
                console.error(`❌ [isChainValid] 创世块 hash 不一致: 收到=${incomingGenesisHash}, 本地=${localGenesisHash}`);
                return false;
            }
        }

        for (let i = 1; i < targetChain.length; i++) {
            let currentBlock = targetChain[i];
            let previousBlock = targetChain[i - 1];

            // 重建 Block 实例（处理从 JSON 反序列化的情况）
            if (!(currentBlock instanceof Block)) {
                const b = currentBlock;
                const txSrc = b.transactions || (b.data ? b.data : []);
                currentBlock = new Block(b.index, b.timestamp, txSrc, b.previousHash);
                currentBlock.nonce = b.nonce;
                currentBlock.hash = b.hash;
                // 同时把原始 transactions 复制过来用于签名验证
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

            // 验证区块自身 hash
            const computedHash = currentBlock.calculateHash();
            if (currentBlock.hash !== computedHash) {
                if (chain) {
                    console.error(`❌ [isChainValid] 区块 #${currentBlock.index} hash 不一致: 原hash=${currentBlock.hash.substring(0, 16)}..., 计算hash=${computedHash.substring(0, 16)}...`);
                }
                return false;
            }

            if (currentBlock.previousHash !== previousBlock.hash) {
                if (chain) {
                    console.error(`❌ [isChainValid] 区块 #${currentBlock.index} 的 previousHash 与前一区块 hash 不匹配`);
                }
                return false;
            }

            // ============================================
            // 验证区块中每笔交易的 ECDSA 签名
            // ============================================
            if (validateSignatures && currentBlock.transactions && Array.isArray(currentBlock.transactions)) {
                for (const tx of currentBlock.transactions) {
                    const txInstance = this._toTransactionInstance(tx);
                    if (txInstance && !txInstance.isValid()) {
                        if (chain) {
                            console.error(`❌ [isChainValid] 区块 #${currentBlock.index} 中一笔交易签名验证失败: tx=${txInstance.id.substring(0, 12)}... from=${txInstance.from.substring(0, 12)}...`);
                        } else {
                            console.error(`❌ [isChainValid] 区块 #${currentBlock.index} 中一笔交易签名验证失败`);
                        }
                        return false;
                    }
                }
            }
        }
        return true;
    }

    // 替换为更长的链
    replaceChain(newChain) {
        if (newChain.length <= this.chain.length) {
            console.log('⚠️  新链不更长，拒绝替换');
            return false;
        }
        if (!this.isChainValid(newChain)) {
            console.log('❌ 新链验证失败，拒绝替换');
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
        const existingPendingIds = new Set(this.pendingTransactions.map(t => t.id));
        const rollbackTx = [];

        // 用于日志确认：显式统计被回滚掉的矿工奖励总额
        let rollbackRewardCount = 0;
        let rollbackRewardAmount = 0;

        for (const block of this.chain) {
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
            this.pendingTransactions = rollbackTx.concat(this.pendingTransactions);
            console.log(`🔄 分叉回滚：已将 ${rollbackTx.length} 笔用户交易放回交易池`);
        }
        if (rollbackRewardCount > 0) {
            console.log(`⛏️  分叉回滚：旧链上 ${rollbackRewardCount} 个区块的矿工奖励已作废（共 ${rollbackRewardAmount} 币，因链被替换自动回滚）`);
        }

        // ---------------------------------------------------------
        // 正式替换链
        // ---------------------------------------------------------
        this.chain = newChain.map((b) => {
            if (b instanceof Block) return b;
            const txSrc = b.transactions || (b.data ? b.data : []);
            const block = new Block(b.index, b.timestamp, txSrc, b.previousHash);
            block.nonce = b.nonce;
            block.hash = b.hash;
            return block;
        });
        this.saveToFile();
        console.log(`✅ 链已替换，新长度: ${this.chain.length}（回滚了 ${rollbackTx.length} 笔交易到交易池）`);
        return true;
    }
}

module.exports = { Blockchain, Block, Transaction, generateWallet };