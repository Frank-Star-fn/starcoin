const fs = require('fs');
const path = require('path');
const { Blockchain } = require('../blockchain/blockchain');
const { Transaction, Block } = require('../core');
const { balance } = require('../consensus');
const { hash, fromUnits, toUnits, targetForDifficulty, targetHex } = require('../protocol');
const { EvmConsensus } = require('./consensus');
const { EvmTransaction } = require('./transaction');
const { evmAddressFromPem, WEI_PER_UNIT } = require('./engine');
const { networkSettings } = require('./network');

class EvmBlockchain extends Blockchain {
    constructor(port, testMode = false, options = {}) {
        super(port, true, options);
        this.testMode = testMode;
        this.evmEnabled = true;
        const evm = options.evm || (testMode ? {} : networkSettings(this.consensus, path.dirname(this.dataFile)));
        this.consensus = new EvmConsensus(this.createGenesisBlock(), options.consensus, evm);
        this._writes = Promise.resolve();
        this.ready = this.initialize();
    }

    loadFromFile() { return false; } // Constructor initialization is awaited via ready.

    async initialize() {
        let saved = null;
        if (!this.testMode && fs.existsSync(this.dataFile)) saved = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
        if (saved && saved.consensusHash !== this.consensus.fingerprint) throw new Error('原生链共识参数不匹配');
        if (saved?.version === '5.0' && saved.evmConsensusHash !== this.consensus.evmFingerprint) throw new Error('EVM 共识参数不匹配');
        const result = await this.consensus.evaluateAsync(saved?.chain || this.chain);
        if (!result.valid) throw new Error('链审计失败（原文件保留）：' + result.error);
        if (saved?.version === '5.0' && saved.evmStateRoot !== result.evmStateRoot) throw new Error('保存的 EVM 状态根与重放结果不匹配');
        const pool = await this.consensus.rebuildPoolAsync(result, saved?.pendingTransactions || []);
        this.install(result, pool, saved?.revertedTransactions || [], saved?.reorgEvents || []);
        this.freshStart = !saved;
        if (saved && saved.version !== '5.0') {
            const backup = this.dataFile + '.pre-evm.json';
            if (!fs.existsSync(backup)) fs.copyFileSync(this.dataFile, backup, fs.constants.COPYFILE_EXCL);
        }
        this.query.getAddressNonce = (value, pending = true) => {
            let next = this._evaluation.state.nonces.get(value) || 0;
            if (pending) for (const tx of this.pendingTransactions.filter(tx => tx.from === value).sort((a, b) => a.nonce - b.nonce)) {
                if (tx.nonce === next) next++;
            }
            return next;
        };
        this.query.getConfirmedNonce = value => this._evaluation.state.nonces.get(value) || 0;
        this.query.getBalance = (value, immature = false, currency = 'STC') => {
            let units = balance(this._evaluation.state, value, currency);
            if (immature && currency === 'STC') for (const reward of this._evaluation.state.locked) if (reward.address === value) units += reward.amount;
            return fromUnits(units);
        };
        this.query.getAllBalances = (value, immature = false) => Object.fromEntries(['STC', 'cBTC', 'cETH'].map(c => [c, this.query.getBalance(value, immature, c)]));
        const nativeFees = this.query.getTotalBurnedFees.bind(this.query);
        this.query.getTotalBurnedFees = () => nativeFees() + Number(this._evaluation.state.evmBurnedWei) / 1e18;
        const recentFees = this.query.getRecentBurnedFees.bind(this.query);
        this.query.getRecentBurnedFees = count => recentFees(count).map(item => {
            const receipts = [...this._evaluation.receipts.values()].filter(receipt => receipt.blockIndex === item.blockIndex && receipt.kind === 'evm');
            return { ...item, totalFees: item.totalFees + Number(receipts.reduce((total, receipt) => total + BigInt(receipt.feeWei), 0n)) / 1e18,
                txWithFeeCount: item.txWithFeeCount + receipts.length };
        });
        const addresses = this.query.getAllAddresses.bind(this.query);
        this.query.getAllAddresses = () => addresses().filter(item => /^[0-9a-f]{32}$/.test(item.address));
    }

    install(result, pool, reverted, events) {
        this.chain = result.blocks;
        this.pendingTransactions = pool.pending;
        this._evaluation = result;
        this._poolState = pool.state;
        this._poolEngine = pool.engine;
        this.diffManager.fromJSON(result);
        this.revertedTransactions = new Map(reverted);
        this.reorgEvents = events;
        this._chainDigest = hash(JSON.stringify(this.chain));
    }

    enqueue(operation) {
        const task = this._writes.then(() => this.ready).then(operation);
        this._writes = task.catch(() => {});
        return task;
    }

    evaluateChain(chain = this.chain) {
        if (chain === this.chain && this._evaluation && hash(JSON.stringify(chain)) === this._chainDigest) return this._evaluation;
        return this.consensus.evaluateAsync(chain);
    }
    isChainValid(chain = this.chain) {
        const result = this.evaluateChain(chain);
        return result?.then ? result.then(value => value.valid) : result.valid;
    }
    getChainWork(chain = this.chain) {
        const result = this.evaluateChain(chain);
        const work = value => { if (!value.valid) throw new Error(value.error); return value.work; };
        return result?.then ? result.then(work) : work(result);
    }

    async commitAsync(result, candidates = this.pendingTransactions, changes = {}) {
        if (!result.valid) throw new Error(result.error);
        const pool = await this.consensus.rebuildPoolAsync(result, candidates);
        const reverted = changes.revertedTransactions || this.revertedTransactions;
        const events = changes.reorgEvents || this.reorgEvents;
        const snapshot = { chain: result.blocks, pendingTransactions: pool.pending, difficulty: result.difficulty,
            difficultyHistory: result.difficultyHistory, lastAdjustmentBlock: result.lastAdjustmentBlock,
            revertedTransactions: [...reverted], reorgEvents: events, evmStateRoot: result.evmStateRoot };
        if (!this.storage.saveToFile(snapshot)) throw new Error('链状态持久化失败；未提交新区块');
        this.install(result, pool, [...reverted], events);
        return pool;
    }

    async addInside(data) {
        const tx = Transaction.fromJSON(data);
        const evaluation = await this.evaluateChain();
        if (!evaluation.valid) throw new Error(evaluation.error);
        const pool = await this.consensus.rebuildPoolAsync(evaluation, [...this.pendingTransactions, tx]);
        if (!pool.pending.some(item => item.id === tx.id) || this.hasPendingTransaction(tx.id)) {
            throw new Error(pool.rejected.find(item => item.id === tx.id)?.error || '交易已存在或无效');
        }
        this.pendingTransactions = pool.pending;
        this._poolState = pool.state;
        this._poolEngine = pool.engine;
        return tx;
    }
    addTransaction(data) { return this.enqueue(() => this.addInside(data)); }
    saveToFile() { return this.enqueue(() => this.storage.saveToFile()); }
    async addPendingTransaction(data) {
        try { return { success: true, transaction: await this.addTransaction(data) }; }
        catch (error) { return { success: false, error: error.message }; }
    }

    submitEvm(pem, options) {
        return this.enqueue(async () => {
            const pool = await this.consensus.rebuildPoolAsync(this._evaluation, this.pendingTransactions);
            this._poolState = pool.state; this._poolEngine = pool.engine; this.pendingTransactions = pool.pending;
            const wallet = require('../core').importWalletFromPem(pem);
            const source = evmAddressFromPem(pem);
            const nativeNonce = this.query.getAddressNonce(wallet.address, true);
            const kind = options.kind || 'evm';
            let tx;
            if (kind === 'evm') {
                const rawTransaction = this._poolEngine.sign(pem, { ...options, nonce: await this._poolEngine.nonce(source) });
                const raw = this._poolEngine.decode(rawTransaction);
                tx = new EvmTransaction({ chainId: this.consensus.params.chainId, kind, from: wallet.address,
                    to: raw.to?.toString() || 'EVM_CREATE', nonce: nativeNonce, evmAddress: source, rawTransaction });
            } else {
                const evmAddress = kind === 'deposit' ? require('./engine').address(options.evmAddress || source) : source;
                tx = new EvmTransaction({ chainId: this.consensus.params.chainId, kind, from: wallet.address,
                    to: kind === 'deposit' ? 'EVM:' + evmAddress : options.nativeAddress || wallet.address,
                    amount: options.amount, fee: options.fee ?? '0', nonce: nativeNonce, evmAddress });
            }
            tx.signTransaction(pem, wallet.publicKey);
            return this.addInside(tx);
        });
    }

    buildCandidate(minerAddress, note = '') {
        return this.enqueue(async () => {
            const evaluation = await this.evaluateChain();
            if (!evaluation.valid) throw new Error(evaluation.error);
            const index = this.chain.length;
            const times = this.chain.slice(-11).map(b => Date.parse(b.timestamp)).sort((a, b) => a - b);
            const timestamp = new Date(Math.max(Date.now(), times[Math.floor(times.length / 2)] + 1)).toISOString();
            const context = { index, timestamp, previousHash: this.getLatestBlock().hash };
            const reward = new Transaction('SYSTEM', minerAddress || this.miningAddress, this.miningReward, 0, 'Miner Reward', 'STC', undefined,
                { version: 2, chainId: this.consensus.params.chainId, blockHeight: index });
            reward.timestamp = timestamp; reward.id = reward.calculateHash();
            const active = index >= this.consensus.evm.activationHeight;
            const selected = active ? await this.consensus.selectAsync(evaluation, this.pendingTransactions, reward, context)
                : this.consensus.selectTransactions(evaluation, this.pendingTransactions);
            const transactions = [reward, ...selected];
            if (note && note.trim()) {
                const tx = new Transaction('', 'NOTE', 0, 0, note.trim(), 'STC', undefined,
                    { version: 2, chainId: this.consensus.params.chainId, blockHeight: index });
                tx.timestamp = timestamp; tx.id = tx.calculateHash(); transactions.push(tx);
            }
            const options = { version: active ? 3 : 2, chainId: this.consensus.params.chainId,
                consensusHash: this.consensus.fingerprint, target: targetHex(targetForDifficulty(evaluation.difficulty)) };
            const block = new Block(index, timestamp, transactions, context.previousHash, options);
            if (active) {
                const result = await this.consensus.executeBlock(evaluation, block);
                Object.assign(block, { evmConsensusHash: this.consensus.evmFingerprint, evmStateRoot: result.evmStateRoot,
                    receiptsRoot: result.receiptsRoot, evmGasUsed: result.evmGasUsed, evmGasLimit: this.consensus.evm.blockGasLimit });
                block.hash = block.calculateHash();
            }
            return { block, difficulty: evaluation.difficulty };
        });
    }

    mineBlock(minerAddress, note) { return this.mineBlockAsync(minerAddress, note); }
    async mineBlockAsync(minerAddress, note, onProgress, abort) {
        const { block, difficulty } = await this.buildCandidate(minerAddress, note);
        const canceled = () => !!abort?.() || this.getLatestBlock().hash !== block.previousHash;
        const result = await block.mineBlockAsync(difficulty, onProgress, 5000, canceled, 150);
        if (result?.aborted || canceled()) return { canceled: true, reason: 'chain_updated' };
        return this.enqueue(async () => {
            if (canceled()) return { canceled: true, reason: 'chain_updated' };
            const accepted = await this.addBlockInside(block);
            if (!accepted) throw new Error('候选区块验证失败');
            return accepted;
        });
    }

    async addBlockInside(block) {
        if (block.hash === this.getLatestBlock().hash) return null;
        const evaluation = await this.consensus.evaluateAsync([...this.chain, block]);
        if (!evaluation.valid) { this.log.warn('拒绝无效区块', { error: evaluation.error }); return null; }
        await this.commitAsync(evaluation);
        return this.getLatestBlock();
    }
    addBlock(block) { return this.enqueue(() => this.addBlockInside(block)); }

    replaceChain(chain) {
        return this.enqueue(async () => {
            const incoming = await this.consensus.evaluateAsync(chain), current = await this.evaluateChain();
            if (!incoming.valid || !current.valid || incoming.work <= current.work) return false;
            let common = 0;
            while (common < this.chain.length && common < incoming.blocks.length && this.chain[common].hash === incoming.blocks[common].hash) common++;
            const depth = this.chain.length - common;
            const rolledBack = this.chain.slice(common).flatMap(b => b.transactions).filter(tx => tx.from && tx.from !== 'SYSTEM' && !incoming.state.ids.has(tx.id));
            const reverted = new Map(this.revertedTransactions);
            for (const tx of rolledBack) reverted.set(tx.id, Transaction.fromJSON(tx));
            for (const id of incoming.state.ids) reverted.delete(id);
            while (reverted.size > 1000) reverted.delete(reverted.keys().next().value);
            const events = this.reorgEvents.slice();
            if (depth) events.push({ depth, commonHeight: common - 1, oldTip: this.getLatestBlock().hash,
                newTip: incoming.blocks.at(-1).hash, timestamp: new Date().toISOString(), deep: depth >= this.deepReorgThreshold });
            await this.commitAsync(incoming, [...this.pendingTransactions, ...rolledBack], { revertedTransactions: reverted, reorgEvents: events.slice(-100) });
            return true;
        });
    }

    repairChain() {
        return this.enqueue(async () => {
            const result = await this.consensus.evaluateAsync(this.chain);
            if (result.valid) return [];
            if (!result.index) throw new Error('检查点或创世块损坏，不能自动截断');
            const removed = this.chain.slice(result.index);
            const valid = await this.consensus.evaluateAsync(this.chain.slice(0, result.index));
            await this.commitAsync(valid, [...this.pendingTransactions, ...removed.flatMap(b => b.transactions).filter(tx => tx.from && tx.from !== 'SYSTEM')]);
            return removed;
        });
    }

    reload() {
        return this.enqueue(async () => {
            if (!fs.existsSync(this.dataFile)) return false;
            const saved = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
            if (saved.consensusHash !== this.consensus.fingerprint || (saved.version === '5.0' && saved.evmConsensusHash !== this.consensus.evmFingerprint)) throw new Error('链文件共识配置不匹配');
            const result = await this.consensus.evaluateAsync(saved.chain);
            if (saved.version === '5.0' && result.evmStateRoot !== saved.evmStateRoot) throw new Error('EVM 状态根不匹配');
            await this.commitAsync(result, saved.pendingTransactions || [], { revertedTransactions: new Map(saved.revertedTransactions || []), reorgEvents: saved.reorgEvents || [] });
            return true;
        });
    }
    clearDataFile() {
        return this.enqueue(async () => {
            if (this.consensus.evm.activationHeight > 1 || this.consensus.params.activationHeight > 1) throw new Error('升级链不能重置到检查点之前');
            await this.commitAsync(await this.consensus.evaluateAsync([this.createGenesisBlock()]), [], { revertedTransactions: new Map(), reorgEvents: [] });
            return true;
        });
    }

    receipt(id) {
        const receipt = this._evaluation.receipts.get(id);
        if (receipt) return { ...receipt, confirmations: this.chain.length - receipt.blockIndex };
        return { id, status: this.hasPendingTransaction(id) ? 'pending' : this.revertedTransactions.has(id) ? 'reverted' : 'unknown',
            wasReverted: this.revertedTransactions.has(id), confirmations: 0 };
    }
}

module.exports = { EvmBlockchain };
