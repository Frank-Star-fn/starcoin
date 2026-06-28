const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');
const { Block, Transaction, generateWallet, importWalletFromPem,
        generateMnemonic, validateMnemonic, mnemonicToWallet,
        SUPPORTED_CURRENCIES, DEFAULT_CURRENCY, effectiveCurrency, normalizeCurrency } = require('../core');
const { ChainSync } = require('../chain-sync');
const { DifficultyManager } = require('../difficulty-manager');
const { QueryEngine } = require('./blockchain-query');
const { StorageManager } = require('./blockchain-storage');

class Blockchain {
    constructor(portOverride, testMode = false) {
        const PORT = portOverride || config.PORT;
        this.testMode = testMode;
        this.diffManager = new DifficultyManager({
            initialDifficulty: config.DIFFICULTY_INITIAL,
            targetBlockTime: config.DIFFICULTY_TARGET_TIME,
            difficultyAdjustInterval: config.DIFFICULTY_ADJUST_INTERVAL,
            difficultyMin: config.DIFFICULTY_MIN,
            difficultyMax: config.DIFFICULTY_MAX,
            difficultyStep: config.DIFFICULTY_STEP
        });
        this.pendingTransactions = [];  // 交易池 (Mempool)
        this.miningReward = config.MINING_REWARD;
        this.coinbaseMaturity = config.MINING_COINBASE_MATURITY;
        this.miningAddress = 'MINER_' + PORT;
        this.chain = [this.createGenesisBlock()]; // 先初始化创世区块
        this.dataFile = path.join(__dirname, '..', '..', 'data', `blockchain_${PORT}.json`);
        this.sync = new ChainSync(this); // 必须在 loadFromFile 前初始化（isChainValid 委托给 sync）
        this.query = new QueryEngine(this); // 查询引擎：封装所有只读搜索操作
        this.storage = new StorageManager(this); // 持久化：封装文件读写
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

    // 添加交易到交易池（支持多币种、nonce 防重放；矿工费始终以 STC 支付）
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
            transaction = new Transaction(
                tx.from, tx.to, tx.amount, tx.fee || 0, tx.note || '', tx.currency, tx.nonce
            );
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

        // ============================================
        // nonce 验证（防重放攻击）：
        // - 有签名 + 有 nonce → 验证 nonce 是否匹配；
        // - 有签名 + 无 nonce → 允许（视为"旧格式、不启用 nonce 防重放"
        //   注意：此时签名不含 nonce，填充 nonce 会破坏签名，故不自动填充）；
        // - 无签名 + 无 nonce → 自动填充。
        // ============================================
        {
            const sender = transaction.from;
            const hasSignature = transaction.signature && transaction.signature.length > 0;
            const hasNonce = (transaction.nonce !== undefined && transaction.nonce !== null);

            if (hasSignature && hasNonce) {
                // 已签名 + 有 nonce → 严格验证
                const expected = this.query.getAddressNonce(sender, true);
                if (Number(transaction.nonce) !== expected) {
                    throw new Error(
                        `[nonce] 交易序号不匹配！地址 ${sender.substring(0, 16)}... ` +
                        `期望 nonce=${expected}，收到 nonce=${transaction.nonce}`
                    );
                }
            } else if (!hasSignature && !hasNonce) {
                // 未签名 + 未提供 nonce → 自动填充（用户可以在之后签名
                transaction.nonce = this.query.getAddressNonce(sender, true);
            }
            // hasSignature && !hasNonce → 保持 nonce=undefined，不自动填充
            // （否则会使 hash 改变，签名验证失败）
        }

        // ============================================
        // 多币种余额检查
        // amount 使用交易币种支付，fee 始终使用 STC 支付
        // ============================================
        const txCurrency = effectiveCurrency(transaction);
        const fee = Number(transaction.fee) || 0;

        if (txCurrency === DEFAULT_CURRENCY) {
            // STC 交易：amount + fee 都从 STC 余额扣
            const senderBalance = this.getBalance(transaction.from, false, DEFAULT_CURRENCY);
            const pendingOutgoing = this.pendingTransactions
                .filter(t => t.from === transaction.from && effectiveCurrency(t) === DEFAULT_CURRENCY)
                .reduce((sum, t) => sum + (Number(t.amount) || 0) + (Number(t.fee) || 0), 0);
            const availableBalance = senderBalance - pendingOutgoing;

            if (availableBalance < transaction.amount + fee) {
                throw new Error(
                    `[STC] 余额不足！已确认余额: ${senderBalance}, ` +
                    `交易池中待打包出账: ${pendingOutgoing}, ` +
                    `可用余额: ${availableBalance}, ` +
                    `当前转账所需: ${transaction.amount + fee}`
                );
            }
        } else {
            // 非 STC 交易：amount 从交易币种余额扣，fee 从 STC 余额扣
            // 1) 检查 amount 余额
            const curBalance = this.getBalance(transaction.from, false, txCurrency);
            const pendingCur = this.pendingTransactions
                .filter(t => t.from === transaction.from && effectiveCurrency(t) === txCurrency)
                .reduce((sum, t) => sum + (Number(t.amount) || 0), 0); // 只累加 amount（fee 已归入 STC）
            const availableCur = curBalance - pendingCur;

            if (availableCur < transaction.amount) {
                throw new Error(
                    `[${txCurrency}] 余额不足！已确认余额: ${curBalance}, ` +
                    `交易池中待打包出账: ${pendingCur}, ` +
                    `可用余额: ${availableCur}, ` +
                    `当前转账所需: ${transaction.amount} ${txCurrency}`
                );
            }

            // 2) 检查 fee 的 STC 余额
            if (fee > 0) {
                const stcBalance = this.getBalance(transaction.from, false, DEFAULT_CURRENCY);
                const pendingStcFee = this.pendingTransactions
                    .filter(t => t.from === transaction.from)
                    .reduce((sum, t) => sum + (Number(t.fee) || 0), 0); // 所有待打包交易的 fee 合计（STC）
                const availableStc = stcBalance - pendingStcFee;

                if (availableStc < fee) {
                    throw new Error(
                        `[STC] 矿工费不足！STC 已确认余额: ${stcBalance}, ` +
                        `交易池中待打包 fee: ${pendingStcFee}, ` +
                        `可用 STC: ${availableStc}, ` +
                        `所需矿工费: ${fee} STC`
                    );
                }
            }
        }

        this.pendingTransactions.push(transaction);
        return transaction;
    }

    /**
     * 检查交易池中是否已存在指定 ID 的交易（用于 P2P 去重）
     * @param {string} txId
     * @returns {boolean}
     */
    hasPendingTransaction(txId) {
        return this.pendingTransactions.some(t => t.id === txId);
    }

    /**
     * 从 P2P 网络接收交易时使用的方法：
     * - 不抛异常（返回错误信息字符串），方便 P2P 层处理
     * - 可选跳过余额检查（不同节点交易池状态不同，余额检查由矿工节点在打包时做最终验证）
     *
     * @param {object} txData - 交易数据（可以是普通 JSON 对象或 Transaction 实例）
     * @param {boolean} skipBalanceCheck - 是否跳过余额检查（默认 true，P2P 场景建议跳过）
     * @returns {{ success: boolean, error?: string, transaction?: object }}
     */
    addPendingTransaction(txData, skipBalanceCheck = true) {
        // 去重检查
        if (this.hasPendingTransaction(txData.id)) {
            return { success: false, error: '交易已存在于交易池中' };
        }

        // 构造 Transaction 对象（传递 currency 与 nonce 字段）
        let tx;
        if (txData instanceof Transaction) {
            tx = txData;
        } else {
            tx = new Transaction(
                txData.from, txData.to, txData.amount,
                txData.fee || 0, txData.note || '', txData.currency, txData.nonce
            );
            if (txData.signature) tx.signature = txData.signature;
            if (txData.publicKey) tx.publicKey = txData.publicKey;
            if (txData.timestamp) tx.timestamp = txData.timestamp;
            if (txData.id) tx.id = txData.id;
        }

        // 基本字段校验（兼容备注交易 from='' 和 SYSTEM 交易）
        const isNoteTx = !tx.from && tx.to === 'NOTE' && tx.amount === 0;
        const isSpecialTx = isNoteTx || tx.from === 'SYSTEM';
        if (!isSpecialTx) {
            if (!tx.from || !tx.to || tx.amount <= 0) {
                return { success: false, error: '交易缺少必要字段（from, to, amount）' };
            }
            if (tx.from === tx.to) {
                return { success: false, error: '不能给自己转账' };
            }
        }

        // ECDSA 签名验证（核心安全检查，不能跳过）
        if (!tx.isValid()) {
            return { success: false, error: '交易签名验证失败' };
        }

        // ============================================
        // nonce 验证（防重放攻击）：
        // - 已签名 + 有 nonce → 严格验证；
        // - 已签名 + 无 nonce → 允许（旧格式兼容，不自动填充以免破坏签名）；
        // - 未签名 + 无 nonce → 自动填充。
        // 对于 SPECIAL 交易（SYSTEM、备注交易）跳过 nonce 验证
        // ============================================
        if (!isSpecialTx) {
            const sender = tx.from;
            const hasSignature = tx.signature && tx.signature.length > 0;
            const hasNonce = (tx.nonce !== undefined && tx.nonce !== null);
            if (hasSignature && hasNonce) {
                const expected = this.query.getAddressNonce(sender, true);
                if (Number(tx.nonce) !== expected) {
                    return {
                        success: false,
                        error: `[nonce] 序号不匹配！地址 ${sender.substring(0, 16)}... 期望 ${expected}，收到 ${tx.nonce}`
                    };
                }
            } else if (!hasSignature && !hasNonce) {
                tx.nonce = this.query.getAddressNonce(sender, true);
            }
        }

        // 多币种余额检查（可选跳过；备注交易和 SYSTEM 交易无需检查余额）
        // amount 使用交易币种支付，fee 始终使用 STC 支付
        if (!skipBalanceCheck && !isSpecialTx) {
            const txCurrency = effectiveCurrency(tx);
            const fee = Number(tx.fee) || 0;

            if (txCurrency === DEFAULT_CURRENCY) {
                // STC 交易：amount + fee 都从 STC 余额扣
                const senderBalance = this.getBalance(tx.from, false, DEFAULT_CURRENCY);
                const pendingOutgoing = this.pendingTransactions
                    .filter(t => t.from === tx.from && effectiveCurrency(t) === DEFAULT_CURRENCY)
                    .reduce((sum, t) => sum + (Number(t.amount) || 0) + (Number(t.fee) || 0), 0);
                const availableBalance = senderBalance - pendingOutgoing;
                if (availableBalance < tx.amount + fee) {
                    return { success: false, error: `[STC] 余额不足：可用 ${availableBalance}，需要 ${tx.amount + fee}` };
                }
            } else {
                // 非 STC 交易：amount 从交易币种余额扣，fee 从 STC 余额扣
                const curBalance = this.getBalance(tx.from, false, txCurrency);
                const pendingCur = this.pendingTransactions
                    .filter(t => t.from === tx.from && effectiveCurrency(t) === txCurrency)
                    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
                const availableCur = curBalance - pendingCur;
                if (availableCur < tx.amount) {
                    return { success: false, error: `[${txCurrency}] 余额不足：可用 ${availableCur}，需要 ${tx.amount} ${txCurrency}` };
                }
                if (fee > 0) {
                    const stcBalance = this.getBalance(tx.from, false, DEFAULT_CURRENCY);
                    const pendingStcFee = this.pendingTransactions
                        .filter(t => t.from === tx.from)
                        .reduce((sum, t) => sum + (Number(t.fee) || 0), 0);
                    const availableStc = stcBalance - pendingStcFee;
                    if (availableStc < fee) {
                        return { success: false, error: `[STC] 矿工费不足：可用 STC ${availableStc}，需要 ${fee} STC` };
                    }
                }
            }
        }

        this.pendingTransactions.push(tx);
        return { success: true, transaction: tx };
    }

    // 从交易池挖矿，打包交易到新区块
    mineBlock(minerAddress, blockDataText) {
        // 准备要打包的交易：按手续费降序排序，优先打包手续费最高的交易
        const sortedTxs = [...this.pendingTransactions].sort((a, b) => (b.fee || 0) - (a.fee || 0));
        const txsToInclude = sortedTxs.slice(0, config.MINING_MAX_TXS_PER_BLOCK);
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
    async mineBlockAsync(minerAddress, blockDataText, onProgress, externalAbortCheck) {
        // 按手续费降序排序，优先打包手续费最高的交易
        const sortedTxs = [...this.pendingTransactions].sort((a, b) => (b.fee || 0) - (a.fee || 0));
        const txsToInclude = sortedTxs.slice(0, config.MINING_MAX_TXS_PER_BLOCK);
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
        // ★ 修复：同时检查外部中止信号（如客户端断开连接），防止孤立挖矿进程堆积
        const shouldAbort = () => {
            if (externalAbortCheck && externalAbortCheck()) return true;
            return this.getLatestBlock().hash !== startingLatestHash;
        };

        // 异步挖矿（让步事件循环，让进度能实时推送）
        // 传入 shouldAbort，让 block.mineBlockAsync 在检测到链变化时提前中止
        const mineResult = await block.mineBlockAsync(this.difficulty, onProgress, 5000, shouldAbort);

        // 如果挖矿被中止（链已更新 或 客户端断开），则丢弃当前区块，交易留在交易池，等调用者重新开始
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

    // ============================================================
    //  余额查询 → 委托给 this.query（QueryEngine）
    // ============================================================

    getBalance(...args)              { return this.query.getBalance(...args); }
    getAllBalances(...args)          { return this.query.getAllBalances(...args); }
    getLockedRewards(...args)        { return this.query.getLockedRewards(...args); }
    getTransactionHistory(...args)   { return this.query.getTransactionHistory(...args); }
    getTotalBurnedFees()             { return this.query.getTotalBurnedFees(); }
    getRecentBurnedFees(count = 20)  { return this.query.getRecentBurnedFees(count); }
    getAllAddresses()                { return this.query.getAllAddresses(); }

    // ============================================================
    //  持久化方法：转发给 this.storage（StorageManager，定义在 blockchain-storage.js）
    // ============================================================

    loadFromFile()    { return this.testMode ? false : this.storage.loadFromFile(); }
    saveToFile()      { return this.testMode ? true  : this.storage.saveToFile(); }
    clearDataFile()   { return this.testMode ? true  : this.storage.clearDataFile(); }

    getLatestBlock() {
        return this.chain[this.chain.length - 1];
    }

    // ============================================================
    //  搜索方法：转发给 this.query（QueryEngine，定义在 blockchain-query.js）
    // ============================================================

    findBlockByIndex(index)      { return this.query.findBlockByIndex(index); }
    findTransactionById(txId)    { return this.query.findTransactionById(txId); }
    search(query)                { return this.query.search(query); }

    addBlock(newBlock) {
        let block = newBlock;
        if (!(newBlock instanceof Block)) {
            const txSource = newBlock.transactions || (newBlock.data ? newBlock.data : []);
            block = new Block(newBlock.index, newBlock.timestamp, txSource, newBlock.previousHash);
            block.nonce = newBlock.nonce;
            block.hash = newBlock.hash;
            block.merkleRoot = newBlock.merkleRoot || null;  // ★ 修复：保留原始 merkleRoot，防止 hash 校验失败
        }
        if (block.hash !== block.calculateHash()) {
            return null;
        }
        this.chain.push(block);

        // 🧹 清理交易池：移除该区块中已确认的交易（防止同一笔交易被其他节点再次打包）
        if (block.transactions && Array.isArray(block.transactions)) {
            const txIdsInBlock = new Set(
                block.transactions
                    .filter(tx => tx.id && tx.from && tx.from !== 'SYSTEM')
                    .map(tx => tx.id)
            );
            if (txIdsInBlock.size > 0) {
                const before = this.pendingTransactions.length;
                this.pendingTransactions = this.pendingTransactions.filter(t => !txIdsInBlock.has(t.id));
                const removed = before - this.pendingTransactions.length;
                if (removed > 0) {
                    console.log(`🧹 [addBlock] 交易池清理：移除了 ${removed} 笔已被区块 #${block.index} 打包的交易`);
                }
            }
        }

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

module.exports = { Blockchain, Block, Transaction, generateWallet, importWalletFromPem,
                    generateMnemonic, validateMnemonic, mnemonicToWallet, normalizeCurrency };