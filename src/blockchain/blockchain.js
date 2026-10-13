const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');
const { Block, Transaction, generateWallet, importWalletFromPem, generateMnemonic,
    validateMnemonic, mnemonicToWallet, normalizeCurrency } = require('../core');
const { Consensus } = require('../consensus');
const { targetForDifficulty, targetHex } = require('../protocol');
const { ChainSync } = require('../chain-sync');
const { QueryEngine } = require('./blockchain-query');
const { StorageManager } = require('./blockchain-storage');
const { MempoolBudget } = require('../mempool-policy');

class Blockchain {
    constructor(portOverride, testMode = false, options = {}) {
        this.log = logger.module('Chain');
        const port = portOverride || config.PORT;
        this.testMode = testMode;
        this.pendingTransactions = [];
        this.revertedTransactions = new Map();
        this.reorgEvents = [];
        this.paymentConfirmations = config.PAYMENT_CONFIRMATIONS;
        this.deepReorgThreshold = config.DEEP_REORG_THRESHOLD;
        if (!Number.isSafeInteger(this.paymentConfirmations) || this.paymentConfirmations < 1
            || !Number.isSafeInteger(this.deepReorgThreshold) || this.deepReorgThreshold < 1) throw new Error('无效确认或重组阈值');
        this.miningAddress = 'MINER_' + port;
        const genesis = this.createGenesisBlock();
        this.consensus = new Consensus(genesis, options.consensus);
        this.diffManager = this.consensus.difficultyManager();
        this.chain = [genesis];
        this.dataFile = options.dataFile || path.join(__dirname, '..', '..', 'data', `blockchain_${port}.json`);
        this.sync = new ChainSync(this);
        this.query = new QueryEngine(this);
        this.storage = new StorageManager(this);
        this.freshStart = !this.loadFromFile();
    }

    get miningReward() { return this.consensus.params.miningReward; }
    get coinbaseMaturity() { return this.consensus.params.coinbaseMaturity; }
    get difficulty() { return this.diffManager.difficulty; }
    set difficulty(value) { this.diffManager.difficulty = value; }
    get difficultyHistory() { return this.diffManager.difficultyHistory; }
    set difficultyHistory(value) { this.diffManager.difficultyHistory = value; }
    get targetBlockTime() { return this.diffManager.targetBlockTime; }
    get difficultyAdjustInterval() { return this.diffManager.difficultyAdjustInterval; }
    get difficultyMin() { return this.diffManager.difficultyMin; }
    get difficultyMax() { return this.diffManager.difficultyMax; }
    get difficultyStep() { return this.diffManager.difficultyStep; }
    get lastAdjustmentBlock() { return this.diffManager.lastAdjustmentBlock; }
    set lastAdjustmentBlock(value) { this.diffManager.lastAdjustmentBlock = value; }

    createGenesisBlock() {
        const block = new Block(0, '2025-01-01T00:00:00.000Z', { data: '创世区块：StarCoin诞生！' }, '0');
        block.transactions[0].id = crypto.createHash('sha256').update('genesis:' +
            block.transactions[0].from + block.transactions[0].to + block.transactions[0].amount + block.transactions[0].note).digest('hex');
        block.transactions[0].timestamp = block.timestamp;
        block.updateMerkleRoot();
        block.hash = block.calculateHash();
        return block;
    }

    evaluateChain(chain = this.chain) { return this.consensus.evaluate(chain); }
    getChainWork(chain = this.chain) {
        const result = this.evaluateChain(chain);
        if (!result.valid) throw new Error(result.error);
        return result.work;
    }

    createTransaction(from, to, amount, fee = 0, note = '', currency = 'STC', nonce) {
        return new Transaction(from, to, amount, fee, note, currency, nonce,
            { version: 2, chainId: this.consensus.params.chainId });
    }

    addTransaction(data) {
        if (!data?.from || !data.to || !(Number(data.amount) > 0)) throw new Error('交易必须包含 from, to, 和正数 amount');
        const tx = Transaction.fromJSON(data);
        new MempoolBudget(this.pendingTransactions).check(tx);
        const evaluation = this.evaluateChain();
        if (!evaluation.valid) throw new Error('本地链无效：' + evaluation.error);
        const pool = this.consensus.rebuildPool(evaluation, this.pendingTransactions);
        this.consensus.applyTransfer(pool.state, tx, this.chain.length, true);
        this.pendingTransactions = [...pool.pending, tx];
        return tx;
    }

    hasPendingTransaction(id) { return this.pendingTransactions.some(tx => tx.id === id); }
    // The old skipBalanceCheck argument no longer bypasses validation.
    addPendingTransaction(data) {
        try { return { success: true, transaction: this.addTransaction(data) }; }
        catch (error) { return { success: false, error: error.message }; }
    }

    buildCandidate(minerAddress, note = '') {
        const evaluation = this.evaluateChain();
        if (!evaluation.valid) throw new Error('本地链无效：' + evaluation.error);
        const index = this.chain.length;
        const timestamps = this.chain.slice(-11).map(b => Date.parse(b.timestamp)).sort((a, b) => a - b);
        const timestamp = new Date(Math.max(Date.now(), timestamps[Math.floor(timestamps.length / 2)] + 1)).toISOString();
        const options = { version: 2, chainId: this.consensus.params.chainId, blockHeight: index };
        const reward = new Transaction('SYSTEM', minerAddress || this.miningAddress, this.miningReward, 0, 'Miner Reward', 'STC', undefined, options);
        reward.timestamp = timestamp; reward.id = reward.calculateHash();
        const transactions = [reward, ...this.consensus.selectTransactions(evaluation, this.pendingTransactions)];
        if (note && note.trim()) {
            const tx = new Transaction('', 'NOTE', 0, 0, note.trim(), 'STC', undefined, options);
            tx.timestamp = timestamp; tx.id = tx.calculateHash(); transactions.push(tx);
        }
        const block = new Block(index, timestamp, transactions, this.getLatestBlock().hash, {
            version: 2, chainId: this.consensus.params.chainId, consensusHash: this.consensus.fingerprint,
            target: targetHex(targetForDifficulty(evaluation.difficulty))
        });
        return { block, difficulty: evaluation.difficulty };
    }

    mineBlock(minerAddress, note) {
        const { block, difficulty } = this.buildCandidate(minerAddress, note);
        block.mineBlock(difficulty);
        const accepted = this.addBlock(block);
        if (!accepted) throw new Error('候选区块验证失败');
        return accepted;
    }

    async mineBlockAsync(minerAddress, note, onProgress, externalAbortCheck) {
        const { block, difficulty } = this.buildCandidate(minerAddress, note);
        const shouldAbort = () => !!externalAbortCheck?.() || this.getLatestBlock().hash !== block.previousHash;
        const result = await block.mineBlockAsync(difficulty, onProgress, 5000, shouldAbort, 150);
        // Recheck after the final callback/await, before changing either chain or pool.
        if (result?.aborted || shouldAbort()) return { canceled: true, reason: 'chain_updated' };
        const accepted = this.addBlock(block);
        if (!accepted) return { canceled: true, reason: 'invalid_candidate' };
        return accepted;
    }

    commitEvaluation(evaluation, candidates = this.pendingTransactions, changes = {}) {
        if (!evaluation.valid) throw new Error(evaluation.error);
        const pool = this.consensus.rebuildPool(evaluation, candidates);
        const reverted = changes.revertedTransactions || this.revertedTransactions;
        const events = changes.reorgEvents || this.reorgEvents;
        const snapshot = { chain: evaluation.blocks, pendingTransactions: pool.pending,
            difficulty: evaluation.difficulty, difficultyHistory: evaluation.difficultyHistory,
            lastAdjustmentBlock: evaluation.lastAdjustmentBlock,
            revertedTransactions: [...reverted], reorgEvents: events };
        if (!this.storage.saveToFile(snapshot)) throw new Error('链状态持久化失败；未提交新区块');
        this.chain = evaluation.blocks;
        this.pendingTransactions = pool.pending;
        this.diffManager.fromJSON(snapshot);
        this.revertedTransactions = reverted;
        this.reorgEvents = events;
        return pool;
    }

    addBlock(data) {
        const evaluation = this.evaluateChain([...this.chain, data]);
        if (!evaluation.valid) { this.log.warn('拒绝无效区块', { error: evaluation.error }); return null; }
        this.commitEvaluation(evaluation);
        return this.getLatestBlock();
    }

    _isCoinbaseMature(index) { return index + this.coinbaseMaturity <= this.getLatestBlock().index; }
    adjustDifficulty() { this.recalculateDifficulty(); }
    recalculateDifficulty() { this.diffManager.recalculateDifficulty(this.chain); }
    getLatestBlock() { return this.chain[this.chain.length - 1]; }
    getBalance(...args) { return this.query.getBalance(...args); }
    getAllBalances(...args) { return this.query.getAllBalances(...args); }
    getLockedRewards(...args) { return this.query.getLockedRewards(...args); }
    getTransactionHistory(...args) { return this.query.getTransactionHistory(...args); }
    getTotalBurnedFees() { return this.query.getTotalBurnedFees(); }
    getRecentBurnedFees(n = 20) { return this.query.getRecentBurnedFees(n); }
    getAllAddresses() { return this.query.getAllAddresses(); }
    findBlockByIndex(index) { return this.query.findBlockByIndex(index); }
    findTransactionById(id) { return this.query.findTransactionById(id); }
    getTransactionStatus(id) { return this.query.getTransactionStatus(id); }
    search(query) { return this.query.search(query); }
    loadFromFile() { return this.storage.loadFromFile(); }
    saveToFile() { return this.storage.saveToFile(); }
    clearDataFile() { return this.storage.clearDataFile(); }
    isChainValid(chain) { return this.sync.isChainValid(chain); }
    repairChain() { return this.sync.repairChain(); }
    replaceChain(chain) { return this.sync.replaceChain(chain); }
}

module.exports = { Blockchain, Block, Transaction, generateWallet, importWalletFromPem,
    generateMnemonic, validateMnemonic, mnemonicToWallet, normalizeCurrency };
