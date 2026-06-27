const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Block, Transaction, generateWallet } = require('./core');
const { ChainSync } = require('./chain-sync');

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
        this.blockMiningTimes = {};         // { blockIndex: miningTimeSeconds }（已废弃，保留兼容）
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
        // 使用链上区块时间戳调整难度，确保所有节点难度一致
        this.adjustDifficulty();
        this.saveToFile();
        return block;
    }

    // 异步挖矿（带进度回调，用于前端可视化）
    async mineBlockAsync(minerAddress, blockDataText, onProgress) {
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

    // 动态难度调整：每 N 个区块，根据链上区块时间戳调整难度
    // 使用区块时间戳而非本地挖矿计时，确保所有节点从同一链推导出相同难度
    adjustDifficulty() {
        const latestIndex = this.getLatestBlock().index;

        // 从创世块之后才开始调整
        if (latestIndex < 2) return;

        // 检查是否需要调整（每 difficultyAdjustInterval 个区块调整一次）
        const blocksSinceLastAdjust = latestIndex - this.lastAdjustmentBlock;
        if (blocksSinceLastAdjust < this.difficultyAdjustInterval) return;

        // 使用链上区块时间戳计算最近 N 个区块的平均出块时间
        // 所有节点共享同一链，因此时间戳一致 → 难度一致
        let totalTime = 0;
        let count = 0;
        const startIdx = Math.max(1, latestIndex - this.difficultyAdjustInterval + 1);
        for (let i = startIdx + 1; i <= latestIndex; i++) {
            const prevBlock = this.chain[i - 1];
            const currBlock = this.chain[i];
            const timeDiff = (new Date(currBlock.timestamp) - new Date(prevBlock.timestamp)) / 1000;
            // 合理范围：0 < timeDiff < 1小时（防止异常时间戳干扰）
            if (timeDiff > 0 && timeDiff < 3600) {
                totalTime += timeDiff;
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

    // 根据链上区块时间戳重新计算难度（用于 P2P 链替换后保持所有节点难度一致）
    // 从头遍历整条链，在每个调整点按区块时间戳计算难度
    recalculateDifficulty() {
        if (this.chain.length < 2) {
            this.difficulty = 5;
            this.lastAdjustmentBlock = 0;
            this.difficultyHistory = [];
            return;
        }

        // 重置为初始难度
        let diff = 5;
        let lastAdj = 0;
        const history = [];

        // 遍历链上每个区块，在调整点用时间戳计算难度
        for (let i = 1; i < this.chain.length; i++) {
            const blocksSinceLast = i - lastAdj;
            if (blocksSinceLast >= this.difficultyAdjustInterval && i >= 2) {
                // 用时间戳计算平均出块时间
                const startIdx = Math.max(1, i - this.difficultyAdjustInterval + 1);
                let totalTime = 0;
                let count = 0;
                for (let j = startIdx + 1; j <= i; j++) {
                    const prevB = this.chain[j - 1];
                    const currB = this.chain[j];
                    const timeDiff = (new Date(currB.timestamp) - new Date(prevB.timestamp)) / 1000;
                    if (timeDiff > 0 && timeDiff < 3600) {
                        totalTime += timeDiff;
                        count++;
                    }
                }

                if (count >= 2) {
                    const avgTime = totalTime / count;
                    const ratio = avgTime / this.targetBlockTime;
                    let delta = 0;
                    if (ratio > 1.15) {
                        delta = -this.difficultyStep * Math.min(3, Math.max(1, Math.round(Math.log2(ratio))));
                    } else if (ratio < 0.85) {
                        delta = +this.difficultyStep * Math.min(3, Math.max(1, Math.round(-Math.log2(ratio))));
                    }
                    if (delta !== 0) {
                        const raw = diff + delta;
                        diff = Math.max(
                            this.difficultyMin,
                            Math.min(this.difficultyMax, Math.round(raw * 10) / 10)
                        );
                    }
                    history.push({
                        blockIndex: i,
                        oldDifficulty: this.difficulty,
                        newDifficulty: diff,
                        avgTime: Math.round(avgTime * 10) / 10,
                        targetTime: this.targetBlockTime,
                        reason: avgTime > this.targetBlockTime * 1.3 ? '出块偏慢 ↓' : '出块偏快 ↑'
                    });
                    lastAdj = i;
                }
            }
        }

        const oldDiff = this.difficulty;
        this.difficulty = diff;
        this.lastAdjustmentBlock = lastAdj;
        this.difficultyHistory = history;

        if (Math.abs(this.difficulty - oldDiff) > 0.01) {
            console.log(
                `⚙️ 难度重新计算 [全链重放]: ${oldDiff} → ${this.difficulty} ` +
                `(基于 ${this.chain.length} 个区块的时间戳, ${history.length} 次调整)`
            );
        }
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
                        block.hash = b.hash;
                        block.merkleRoot = b.merkleRoot || null;  // 恢复 merkleRoot（旧数据为 null，兼容旧链）
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

module.exports = { Blockchain, Block, Transaction, generateWallet };