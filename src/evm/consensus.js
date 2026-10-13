const { Consensus, cloneState, balance, credit, restoreBlock } = require('../consensus');
const { calculateMerkleRoot, Transaction } = require('../core');
const { toUnits, hash, targetForDifficulty, targetHex, meetsTarget, workForTarget } = require('../protocol');
const { EvmEngine, address, evmAddressFromPublicKey, WEI_PER_UNIT } = require('./engine');
const { evmSettings } = require('./settings');

function cloneNative(state) {
    return { ...cloneState(state), bridgeLockedWei: state.bridgeLockedWei || 0n, evmBurnedWei: state.evmBurnedWei || 0n };
}

class EvmConsensus extends Consensus {
    constructor(genesis, nativeOptions = {}, evmOptions = {}) {
        super(genesis, nativeOptions);
        this.evm = evmSettings(evmOptions);
        this.evmFingerprint = hash(JSON.stringify([this.fingerprint, this.evm.fingerprint]));
    }

    validateEnvelope(tx, state) {
        if (tx.chainId !== this.params.chainId || !['evm', 'deposit', 'withdraw'].includes(tx.kind)
            || tx.version !== 3 || !/^[0-9a-f]{64}$/.test(tx.id || '') || !/^[0-9a-f]{32}$/.test(tx.from || '')
            || typeof tx.to !== 'string' || tx.to.length > 128 || tx.currency !== 'STC'
            || tx.note !== '' || !Number.isFinite(Date.parse(tx.timestamp)) || tx.blockHeight !== undefined
            || typeof tx.signature !== 'string' || !/^[0-9a-f]{16,512}$/.test(tx.signature)
            || typeof tx.publicKey !== 'string' || !/^[0-9a-f]{16,1024}$/.test(tx.publicKey)
            || !tx.isValid()) throw new Error('无效 EVM 交易封装或签名');
        const expected = state.nonces.get(tx.from) || 0;
        if (!Number.isSafeInteger(tx.nonce) || tx.nonce !== expected || expected >= Number.MAX_SAFE_INTEGER) throw new Error(`原生 nonce 不匹配：期望 ${expected}`);
        if (state.ids.has(tx.id)) throw new Error('交易已确认或重复');
        return { amount: toUnits(tx.amount), fee: toUnits(tx.fee), source: evmAddressFromPublicKey(tx.publicKey) };
    }

    async applyTransaction(state, engine, tx, context, gasUsed = 0n, reserveOnly = false) {
        if (tx.version !== 3) { super.applyTransfer(state, tx, context.index, reserveOnly); return null; }
        const { amount, fee, source } = this.validateEnvelope(tx, state);
        if (balance(state, tx.from, 'STC') < fee) throw new Error('原生手续费余额不足');
        let receipt;
        if (tx.kind === 'deposit') {
            const target = address(tx.evmAddress);
            if (amount <= 0n || tx.to !== 'EVM:' + target || tx.rawTransaction !== ''
                || balance(state, tx.from, 'STC') < amount + fee) throw new Error('存入金额、地址或余额无效');
            credit(state, tx.from, 'STC', -amount);
            await engine.moveBalance(target, amount * WEI_PER_UNIT);
            state.bridgeLockedWei += amount * WEI_PER_UNIT;
            receipt = { id: tx.id, kind: 'deposit', status: 1, evmAddress: target, valueWei: (amount * WEI_PER_UNIT).toString(), gasUsed: '0', feeWei: '0', logs: [] };
        } else if (tx.kind === 'withdraw') {
            if (amount <= 0n || !/^[0-9a-f]{32}$/.test(tx.to) || tx.evmAddress !== source || tx.rawTransaction !== '') throw new Error('取回金额或地址无效');
            await engine.moveBalance(source, -amount * WEI_PER_UNIT);
            if (!reserveOnly) credit(state, tx.to, 'STC', amount);
            state.bridgeLockedWei -= amount * WEI_PER_UNIT;
            receipt = { id: tx.id, kind: 'withdraw', status: 1, evmAddress: source, nativeAddress: tx.to,
                valueWei: (amount * WEI_PER_UNIT).toString(), gasUsed: '0', feeWei: '0', logs: [] };
        } else {
            const raw = engine.decode(tx.rawTransaction);
            if (amount !== 0n || fee !== 0n || tx.evmAddress !== source || raw.getSenderAddress().toString() !== source
                || tx.to !== (raw.to?.toString() || 'EVM_CREATE')) throw new Error('EVM 签名地址或交易字段不匹配');
            receipt = { id: tx.id, kind: 'evm', ...await engine.execute(tx.rawTransaction, context, gasUsed) };
            const burned = BigInt(receipt.feeWei);
            state.evmBurnedWei += burned;
            state.bridgeLockedWei -= burned;
        }
        if (state.bridgeLockedWei < 0n) throw new Error('EVM 资金衔接余额无效');
        credit(state, tx.from, 'STC', -fee);
        state.nonces.set(tx.from, tx.nonce + 1);
        state.ids.add(tx.id);
        return receipt;
    }

    async executeBlock(previous, block) {
        const state = cloneNative(previous.state);
        const engine = await previous.engine.fork(previous.blocks);
        this.releaseRewards(state, block.index);
        if (!block.transactions.length || block.transactions.length > this.params.maxTransactions + 2) throw new Error('区块交易数量无效');
        const receipts = [];
        let gasUsed = 0n, rewards = 0, notes = 0, transfers = 0;
        for (let i = 0; i < block.transactions.length; i++) {
            const tx = block.transactions[i];
            if (tx.from && tx.from !== 'SYSTEM') {
                const receipt = await this.applyTransaction(state, engine, tx, block, gasUsed);
                if (receipt) { receipts.push(receipt); gasUsed += BigInt(receipt.gasUsed); }
                if (++transfers > this.params.maxTransactions) throw new Error('区块交易数量超限');
                continue;
            }
            const { amount, fee, currency } = super.validateFields(tx, block.index);
            if (state.ids.has(tx.id) || fee !== 0n || currency !== 'STC' || (tx.signature ?? '') !== '' || (tx.publicKey ?? '') !== ''
                || tx.nonce !== undefined || tx.blockHeight !== block.index || tx.timestamp !== block.timestamp) throw new Error('特殊交易字段无效');
            if (tx.from === 'SYSTEM') {
                if (i !== 0 || ++rewards !== 1 || amount !== toUnits(this.params.miningReward) || tx.to === 'NOTE' || tx.to === 'SYSTEM') throw new Error('矿工奖励无效');
                state.locked.push({ height: block.index, address: tx.to, amount });
                this.releaseRewards(state, block.index);
            } else if (tx.from !== '' || tx.to !== 'NOTE' || amount !== 0n || ++notes > 1) throw new Error('备注交易无效');
            state.ids.add(tx.id);
        }
        if (rewards !== 1 || gasUsed > BigInt(this.evm.blockGasLimit)) throw new Error('区块奖励或 Gas 无效');
        return { state, engine, receipts, evmStateRoot: await engine.root(), receiptsRoot: hash(JSON.stringify(receipts)), evmGasUsed: gasUsed.toString() };
    }

    async evaluateAsync(chain) {
        let index = 0;
        try {
            if (!Array.isArray(chain) || !chain.length) throw new Error('空链');
            const blocks = chain.map(restoreBlock);
            const activation = this.evm.activationHeight;
            if (blocks.length >= activation && activation > 1 && blocks[activation - 1].hash !== this.evm.checkpointHash) throw new Error('EVM 升级检查点不匹配');
            const legacy = super.evaluate(blocks.slice(0, Math.min(activation, blocks.length)));
            if (!legacy.valid) return legacy;
            let result = { ...legacy, state: cloneNative(legacy.state), engine: await EvmEngine.create(this.evm, legacy.blocks), receipts: new Map() };
            const dm = this.difficultyManager();
            dm.fromJSON({ difficulty: legacy.difficulty, difficultyHistory: legacy.difficultyHistory, lastAdjustmentBlock: legacy.lastAdjustmentBlock });
            for (index = activation; index < blocks.length; index++) {
                const block = blocks[index], previous = blocks[index - 1];
                const median = blocks.slice(Math.max(0, index - 11), index).map(b => Date.parse(b.timestamp)).sort((a, b) => a - b);
                const time = Date.parse(block.timestamp), target = targetForDifficulty(dm.difficulty);
                if (block.version !== 3 || block.index !== index || block.previousHash !== previous.hash
                    || !Number.isSafeInteger(block.nonce) || block.nonce < 0 || typeof block.timestamp !== 'string'
                    || !Number.isFinite(time) || time <= median[Math.floor(median.length / 2)] || time > Date.now() + this.params.maxFutureSeconds * 1000
                    || block.chainId !== this.params.chainId || block.consensusHash !== this.fingerprint || block.evmConsensusHash !== this.evmFingerprint
                    || block.target !== targetHex(target) || block.evmGasLimit !== this.evm.blockGasLimit
                    || block.merkleRoot !== calculateMerkleRoot(block.transactions) || block.hash !== block.calculateHash()
                    || !meetsTarget(block.hash, target)) throw new Error('v3 区块头、共识配置或 PoW 无效');
                const executed = await this.executeBlock(result, block);
                if (executed.evmStateRoot !== block.evmStateRoot || executed.receiptsRoot !== block.receiptsRoot || executed.evmGasUsed !== block.evmGasUsed) {
                    throw new Error('EVM 状态根、回执承诺或 Gas 不匹配');
                }
                const receipts = new Map(result.receipts);
                for (const receipt of executed.receipts) receipts.set(receipt.id, { ...receipt, blockIndex: index, blockHash: block.hash });
                result = { ...result, ...executed, receipts, blocks: blocks.slice(0, index + 1), work: result.work + workForTarget(target) };
                dm.adjustDifficulty(blocks, index);
            }
            return { ...result, valid: true, difficulty: dm.difficulty, difficultyHistory: dm.difficultyHistory,
                lastAdjustmentBlock: dm.lastAdjustmentBlock, evmStateRoot: await result.engine.root() };
        } catch (error) { return { valid: false, error: error.message, index }; }
    }

    async rebuildPoolAsync(evaluation, candidates) {
        let state = cloneNative(evaluation.state), engine = await evaluation.engine.fork(evaluation.blocks);
        const pending = [], rejected = [];
        const context = { index: evaluation.blocks.length, timestamp: new Date(Math.max(Date.now(), Date.parse(evaluation.blocks.at(-1).timestamp) + 1)).toISOString(), previousHash: evaluation.blocks.at(-1).hash };
        for (const candidate of [...candidates].sort((a, b) => (a?.nonce ?? 0) - (b?.nonce ?? 0))) {
            try {
                const tx = Transaction.fromJSON(candidate), trial = cloneNative(state);
                if (tx.version === 3 && context.index < this.evm.activationHeight) throw new Error('EVM 尚未激活');
                const fork = tx.version === 3 ? await engine.fork(evaluation.blocks) : engine;
                await this.applyTransaction(trial, fork, tx, context, 0n, true);
                state = trial; engine = fork; pending.push(tx);
            } catch (error) { rejected.push({ id: candidate?.id, error: error.message }); }
        }
        return { pending, rejected, state, engine };
    }

    async selectAsync(evaluation, candidates, reward, context) {
        let state = cloneNative(evaluation.state), engine = await evaluation.engine.fork(evaluation.blocks), gasUsed = 0n;
        this.releaseRewards(state, context.index);
        state.locked.push({ height: context.index, address: reward.to, amount: toUnits(reward.amount) });
        this.releaseRewards(state, context.index);
        const selected = [], remaining = [...candidates].sort((a, b) => Number(b.fee) - Number(a.fee));
        while (remaining.length && selected.length < this.params.maxTransactions) {
            let chosen = -1;
            for (let i = 0; i < remaining.length; i++) {
                try {
                    const trial = cloneNative(state), fork = remaining[i].version === 3 ? await engine.fork(evaluation.blocks) : engine;
                    const receipt = await this.applyTransaction(trial, fork, remaining[i], context, gasUsed);
                    state = trial; engine = fork;
                    if (receipt) gasUsed += BigInt(receipt.gasUsed);
                    chosen = i; break;
                } catch { /* A sender's preceding nonce can become executable on the next pass. */ }
            }
            if (chosen < 0) break;
            selected.push(remaining.splice(chosen, 1)[0]);
        }
        return selected;
    }
}

module.exports = { EvmConsensus, cloneNative };
