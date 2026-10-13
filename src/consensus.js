const config = require('./config');
const { Block, Transaction, calculateMerkleRoot, SUPPORTED_CURRENCIES } = require('./core');
const { DifficultyManager } = require('./difficulty-manager');
const { toUnits, MAX_UNITS, hash, targetForDifficulty, targetHex, meetsTarget, workForTarget } = require('./protocol');

function cloneState(state) {
    return { balances: new Map(state.balances), nonces: new Map(state.nonces),
        ids: new Set(state.ids), locked: state.locked.map(item => ({ ...item })) };
}
function key(address, currency) { return address + ':' + currency; }
function balance(state, address, currency) { return state.balances.get(key(address, currency)) || 0n; }
function credit(state, address, currency, value) {
    const total = balance(state, address, currency) + value;
    if (total < 0n || total > MAX_UNITS) throw new Error(`[${currency}] 余额不足或超出范围`);
    state.balances.set(key(address, currency), total);
}
function restoreBlock(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.transactions)) throw new Error('无效区块对象');
    const block = Object.create(Block.prototype);
    for (const name of ['version', 'chainId', 'consensusHash', 'target', 'index', 'timestamp',
        'previousHash', 'nonce', 'hash', 'merkleRoot', 'data']) {
        if (Object.hasOwn(data, name)) block[name] = data[name];
    }
    block.version = data.version ?? 1;
    block.transactions = data.transactions.map(tx => Transaction.fromJSON(tx));
    return block;
}

class Consensus {
    constructor(genesis, overrides = {}) {
        this.genesis = restoreBlock(genesis);
        this.genesis.transactions.forEach(Object.freeze);
        Object.freeze(this.genesis.transactions);
        Object.freeze(this.genesis);
        this.params = Object.freeze({
            chainId: config.CHAIN_ID, activationHeight: config.PROTOCOL_ACTIVATION_HEIGHT,
            legacyCheckpointHash: config.LEGACY_CHECKPOINT_HASH,
            initialDifficulty: config.DIFFICULTY_INITIAL, targetBlockTime: config.DIFFICULTY_TARGET_TIME,
            difficultyAdjustInterval: config.DIFFICULTY_ADJUST_INTERVAL,
            difficultyMin: config.DIFFICULTY_MIN, difficultyMax: config.DIFFICULTY_MAX,
            difficultyStep: config.DIFFICULTY_STEP, miningReward: config.MINING_REWARD,
            coinbaseMaturity: config.MINING_COINBASE_MATURITY,
            maxTransactions: config.MINING_MAX_TXS_PER_BLOCK,
            maxFutureSeconds: config.MAX_FUTURE_BLOCK_SECONDS, ...overrides
        });
        const p = this.params;
        if (typeof p.chainId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.chainId)
            || !Number.isSafeInteger(p.activationHeight) || p.activationHeight < 1
            || (p.activationHeight > 1 && !/^[0-9a-f]{64}$/.test(p.legacyCheckpointHash))
            || !Number.isSafeInteger(p.coinbaseMaturity) || p.coinbaseMaturity < 0
            || !Number.isSafeInteger(p.maxTransactions) || p.maxTransactions < 1
            || !Number.isSafeInteger(p.maxFutureSeconds) || p.maxFutureSeconds < 0
            || !Number.isSafeInteger(p.difficultyAdjustInterval) || p.difficultyAdjustInterval < 3
            || !Number.isFinite(p.targetBlockTime) || p.targetBlockTime <= 0
            || !Number.isFinite(p.difficultyStep) || p.difficultyStep <= 0
            || !Number.isFinite(p.difficultyMin) || !Number.isFinite(p.difficultyMax)
            || p.difficultyMin < 0 || p.difficultyMax > 63 || p.difficultyMin > p.difficultyMax
            || p.initialDifficulty < p.difficultyMin || p.initialDifficulty > p.difficultyMax) {
            throw new Error('无效共识参数；历史迁移必须指定激活高度前一块的固定检查点');
        }
        targetForDifficulty(p.initialDifficulty);
        if (toUnits(p.miningReward) <= 0n) throw new Error('无效矿工奖励');
        this.fingerprint = hash(JSON.stringify(p));
    }

    difficultyManager() {
        const dm = new DifficultyManager(this.params);
        dm.log = { info() {} };
        return dm;
    }

    releaseRewards(state, height) {
        const remaining = [];
        for (const reward of state.locked) {
            if (reward.height + this.params.coinbaseMaturity <= height) credit(state, reward.address, 'STC', reward.amount);
            else remaining.push(reward);
        }
        state.locked = remaining;
    }

    validateFields(tx, height) {
        if (!/^[0-9a-f]{64}$/.test(tx.id || '') || typeof tx.from !== 'string'
            || typeof tx.to !== 'string' || !tx.to || tx.to.length > 128
            || typeof tx.note !== 'string' || tx.note.length > 4096
            || typeof tx.timestamp !== 'string' || !Number.isFinite(Date.parse(tx.timestamp))) throw new Error('交易字段无效');
        const amount = toUnits(tx.amount);
        const fee = toUnits(tx.fee);
        if (tx.version !== 1 && tx.version !== 2) throw new Error('不支持的交易版本');
        if (height >= this.params.activationHeight && tx.version !== 2) throw new Error('激活后必须使用 v2 交易和 nonce');
        if (tx.version === 2 && (tx.chainId !== this.params.chainId || tx.id !== tx.calculateHash())) throw new Error('交易 chainId 或内容哈希不匹配');
        const currency = tx.version === 2 ? tx.currency : tx.currency ?? 'STC';
        if (!SUPPORTED_CURRENCIES.includes(currency)) throw new Error('不支持的币种');
        return { amount, fee, currency };
    }

    applyTransfer(state, tx, height, reserveOnly = false) {
        const { amount, fee, currency } = this.validateFields(tx, height);
        if (!tx.from || tx.from === 'SYSTEM' || tx.to === 'NOTE' || amount <= 0n) throw new Error('交易必须包含 from, to, 和正数 amount；禁止系统交易入池');
        if (tx.from === tx.to) throw new Error('不能给自己转账');
        if (tx.blockHeight !== undefined) throw new Error('普通交易不能携带奖励高度');
        if (state.ids.has(tx.id)) throw new Error('交易已确认或重复');
        if (typeof tx.signature !== 'string' || !/^[0-9a-f]{16,512}$/.test(tx.signature)
            || typeof tx.publicKey !== 'string' || !/^[0-9a-f]{16,1024}$/.test(tx.publicKey)
            || !tx.isValid()) throw new Error('交易签名验证失败');
        const expected = state.nonces.get(tx.from) || 0;
        if ((tx.version === 2 || tx.nonce !== undefined)
            && (!Number.isSafeInteger(tx.nonce) || tx.nonce !== expected)) throw new Error(`[nonce] 序号不匹配：期望 ${expected}`);
        if (expected >= Number.MAX_SAFE_INTEGER) throw new Error('nonce 超出范围');
        if (balance(state, tx.from, currency) < amount + (currency === 'STC' ? fee : 0n)) throw new Error(`[${currency}] 余额不足`);
        if (currency !== 'STC' && balance(state, tx.from, 'STC') < fee) throw new Error('[STC] 矿工费不足');
        if (!reserveOnly && balance(state, tx.to, currency) + amount > MAX_UNITS) throw new Error('接收方余额超出范围');
        credit(state, tx.from, currency, -amount);
        credit(state, tx.from, 'STC', -fee);
        if (!reserveOnly) credit(state, tx.to, currency, amount);
        state.nonces.set(tx.from, expected + 1);
        state.ids.add(tx.id);
    }

    applyBlock(state, block) {
        const height = block.index;
        this.releaseRewards(state, height);
        if (!block.transactions.length || block.transactions.length > this.params.maxTransactions + 2) throw new Error('区块交易数量无效');
        let rewards = 0, notes = 0, transfers = 0;
        for (let i = 0; i < block.transactions.length; i++) {
            const tx = block.transactions[i];
            if (tx.from && tx.from !== 'SYSTEM') {
                this.applyTransfer(state, tx, height);
                if (++transfers > this.params.maxTransactions) throw new Error('区块交易数量超限');
                continue;
            }
            const { amount, fee, currency } = this.validateFields(tx, height);
            if (state.ids.has(tx.id)) throw new Error('区块存在重复交易');
            if (fee !== 0n || currency !== 'STC' || (tx.signature ?? '') !== '' || (tx.publicKey ?? '') !== '' || tx.nonce !== undefined) throw new Error('特殊交易字段无效');
            if (tx.version === 2 && (tx.blockHeight !== height || tx.timestamp !== block.timestamp)) throw new Error('特殊交易未绑定区块高度和时间');
            if (tx.from === 'SYSTEM') {
                if (i !== 0 || ++rewards !== 1 || amount !== toUnits(this.params.miningReward) || tx.to === 'NOTE' || tx.to === 'SYSTEM') throw new Error('矿工奖励数量、位置或金额无效');
                state.locked.push({ height, address: tx.to, amount });
                this.releaseRewards(state, height);
            } else {
                if (tx.from !== '' || tx.to !== 'NOTE' || amount !== 0n || ++notes > 1) throw new Error('备注交易无效');
            }
            state.ids.add(tx.id);
        }
        if (rewards !== 1) throw new Error('每个区块必须有一笔矿工奖励');
    }

    evaluate(chain) {
        let index = 0;
        try {
            if (!Array.isArray(chain) || !chain.length) throw new Error('空链');
            const blocks = [];
            for (index = 0; index < chain.length; index++) blocks.push(restoreBlock(chain[index]));
            index = 0;
            const genesis = blocks[0];
            if (genesis.version !== 1 || genesis.index !== 0 || genesis.previousHash !== '0'
                || genesis.timestamp !== this.genesis.timestamp || genesis.nonce !== 0
                || genesis.hash !== this.genesis.hash || genesis.hash !== genesis.calculateHash()
                || genesis.merkleRoot !== calculateMerkleRoot(genesis.transactions)
                || genesis.merkleRoot !== this.genesis.merkleRoot) throw new Error('创世区块不匹配');
            const p = this.params;
            if (p.activationHeight > 1 && (blocks.length < p.activationHeight
                || blocks[p.activationHeight - 1].hash !== p.legacyCheckpointHash)) throw new Error('历史检查点不匹配');
            const state = { balances: new Map(), nonces: new Map(), ids: new Set(genesis.transactions.map(tx => tx.id)), locked: [] };
            const dm = this.difficultyManager();
            let work = 0n;
            for (index = 1; index < blocks.length; index++) {
                const b = blocks[index], prev = blocks[index - 1];
                const modern = index >= p.activationHeight;
                if (b.index !== index || b.previousHash !== prev.hash || !Number.isSafeInteger(b.nonce) || b.nonce < 0) throw new Error('区块高度、父块或 nonce 无效');
                const time = Date.parse(b.timestamp);
                const medianTimes = blocks.slice(Math.max(0, index - 11), index).map(item => Date.parse(item.timestamp)).sort((a, c) => a - c);
                if (typeof b.timestamp !== 'string' || !Number.isFinite(time)
                    || time > Date.now() + p.maxFutureSeconds * 1000
                    || (modern && time <= medianTimes[Math.floor(medianTimes.length / 2)])) throw new Error('区块时间戳无效');
                const target = targetForDifficulty(dm.difficulty, !modern);
                if (modern && (b.version !== 2 || b.chainId !== p.chainId || b.consensusHash !== this.fingerprint || b.target !== targetHex(target))) throw new Error('区块版本、chainId、共识参数或难度目标不匹配');
                if (!modern && b.version !== 1) throw new Error('激活前区块必须是历史格式');
                if (b.merkleRoot !== calculateMerkleRoot(b.transactions)) throw new Error('Merkle 根不匹配');
                if (b.hash !== b.calculateHash()) throw new Error('区块 hash 不匹配');
                if (!meetsTarget(b.hash, target)) throw new Error('区块 PoW 不足');
                this.applyBlock(state, b);
                work += workForTarget(target);
                dm.adjustDifficulty(blocks, index);
            }
            return { valid: true, blocks, state, work, difficulty: dm.difficulty,
                difficultyHistory: dm.difficultyHistory, lastAdjustmentBlock: dm.lastAdjustmentBlock };
        } catch (error) { return { valid: false, error: error.message, index }; }
    }

    rebuildPool(evaluation, candidates) {
        if (!evaluation.valid) throw new Error(evaluation.error);
        const state = cloneState(evaluation.state);
        const pending = [], rejected = [];
        const ordered = [...candidates].sort((a, b) => (a?.nonce ?? 0) - (b?.nonce ?? 0));
        for (const candidate of ordered) {
            try {
                const tx = Transaction.fromJSON(candidate);
                // Invalid transactions cannot leave partial reservations behind.
                const trial = cloneState(state);
                this.applyTransfer(trial, tx, evaluation.blocks.length, true);
                Object.assign(state, trial);
                pending.push(tx);
            } catch (error) { rejected.push({ id: candidate?.id, error: error.message }); }
        }
        return { pending, rejected, state };
    }

    selectTransactions(evaluation, pending) {
        const state = cloneState(evaluation.state), selected = [];
        const height = evaluation.blocks.length;
        this.releaseRewards(state, height);
        const remaining = [...pending].sort((a, b) => Number(b.fee) - Number(a.fee));
        while (remaining.length && selected.length < this.params.maxTransactions) {
            let chosen = -1;
            for (let i = 0; i < remaining.length; i++) {
                const trial = cloneState(state);
                try {
                    this.applyTransfer(trial, remaining[i], height);
                    Object.assign(state, trial); chosen = i; break;
                } catch { /* A higher nonce may become executable on the next pass. */ }
            }
            if (chosen < 0) break;
            selected.push(remaining.splice(chosen, 1)[0]);
        }
        return selected;
    }
}

module.exports = { Consensus, cloneState, balance, restoreBlock };
