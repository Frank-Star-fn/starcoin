const { Transaction } = require('./core');
const logger = require('./logger');

class ChainSync {
    constructor(blockchain) { this.blockchain = blockchain; this.log = logger.module('ChainSync'); }
    _toTransactionInstance(tx) { return tx ? Transaction.fromJSON(tx) : null; }
    isChainValid(chain) { return this.blockchain.evaluateChain(chain || this.blockchain.chain).valid; }
    _findFirstInvalidIndex() {
        const result = this.blockchain.evaluateChain();
        return result.valid ? -1 : result.index;
    }
    repairChain() {
        const bc = this.blockchain;
        const index = this._findFirstInvalidIndex();
        if (index === -1) return [];
        if (index === 0) throw new Error('创世块或历史检查点损坏，不能自动截断');
        const removed = bc.chain.slice(index);
        const evaluation = bc.evaluateChain(bc.chain.slice(0, index));
        if (!evaluation.valid) throw new Error(evaluation.error);
        const candidates = [...bc.pendingTransactions, ...removed.flatMap(b => b.transactions).filter(tx => tx.from && tx.from !== 'SYSTEM')];
        bc.commitEvaluation(evaluation, candidates);
        this.log.warn('截断无效链并重新验证交易池', { index, removed: removed.length });
        return removed;
    }
    replaceChain(chain) {
        const bc = this.blockchain;
        const incoming = bc.evaluateChain(chain);
        const current = bc.evaluateChain();
        if (!incoming.valid || !current.valid || incoming.work <= current.work) return false;
        let common = 0;
        while (common < bc.chain.length && common < incoming.blocks.length && bc.chain[common].hash === incoming.blocks[common].hash) common++;
        const depth = bc.chain.length - common;
        const rolledBack = bc.chain.slice(common).flatMap(b => b.transactions).filter(tx => tx.from && tx.from !== 'SYSTEM' && !incoming.state.ids.has(tx.id));
        const reverted = new Map(bc.revertedTransactions);
        for (const tx of rolledBack) reverted.set(tx.id, Transaction.fromJSON(tx));
        for (const id of incoming.state.ids) reverted.delete(id);
        while (reverted.size > 1000) reverted.delete(reverted.keys().next().value);
        const events = [...bc.reorgEvents];
        if (depth > 0) events.push({ depth, commonHeight: common - 1, oldTip: bc.getLatestBlock().hash,
            newTip: incoming.blocks.at(-1).hash, timestamp: new Date().toISOString(), deep: depth >= bc.deepReorgThreshold });
        bc.commitEvaluation(incoming, [...bc.pendingTransactions, ...rolledBack], {
            revertedTransactions: reverted, reorgEvents: events.slice(-100)
        });
        if (depth >= bc.deepReorgThreshold) this.log.error('深度链重组告警', { depth, threshold: bc.deepReorgThreshold });
        this.log.info('采用累计工作量更高的有效链', { work: incoming.work.toString(), depth });
        return true;
    }
}
module.exports = { ChainSync };
