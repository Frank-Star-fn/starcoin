const fs = require('fs');
const path = require('path');
const logger = require('../logger');

class StorageManager {
    constructor(blockchain) { this.blockchain = blockchain; this.log = logger.module('Storage'); }

    loadFromFile() {
        const bc = this.blockchain;
        if (bc.testMode || !fs.existsSync(bc.dataFile)) return false;
        // Do not regenerate hashes, skip signatures, or reset the chain on failure.
        // A bad file remains available for audit and recovery.
        let saved;
        try { saved = JSON.parse(fs.readFileSync(bc.dataFile, 'utf8')); }
        catch (error) { throw new Error('本地链读取失败（原文件已保留）：' + error.message); }
        if (saved.version === '4.0' && saved.consensusHash !== bc.consensus.fingerprint) throw new Error('本地链共识参数不匹配');
        const result = bc.evaluateChain(saved.chain);
        if (!result.valid) throw new Error('本地链审计失败（原文件已保留）：区块 ' + result.index + '，' + result.error);
        const pool = bc.consensus.rebuildPool(result, Array.isArray(saved.pendingTransactions) ? saved.pendingTransactions : []);
        bc.chain = result.blocks;
        bc.pendingTransactions = pool.pending;
        bc.diffManager.fromJSON({ difficulty: result.difficulty, difficultyHistory: result.difficultyHistory, lastAdjustmentBlock: result.lastAdjustmentBlock });
        bc.revertedTransactions = new Map(Array.isArray(saved.revertedTransactions) ? saved.revertedTransactions.slice(-1000) : []);
        bc.reorgEvents = Array.isArray(saved.reorgEvents) ? saved.reorgEvents.slice(-100) : [];
        this.log.info('本地链完整验证通过', { blocks: bc.chain.length });
        return true;
    }

    saveToFile(snapshot) {
        const bc = this.blockchain;
        if (bc.testMode) return true;
        const temporary = bc.dataFile + '.tmp';
        try {
            const data = snapshot || { chain: bc.chain, pendingTransactions: bc.pendingTransactions,
                difficulty: bc.difficulty, difficultyHistory: bc.difficultyHistory,
                lastAdjustmentBlock: bc.lastAdjustmentBlock, revertedTransactions: [...bc.revertedTransactions], reorgEvents: bc.reorgEvents };
            fs.mkdirSync(path.dirname(bc.dataFile), { recursive: true });
            const fd = fs.openSync(temporary, 'w');
            try {
                fs.writeFileSync(fd, JSON.stringify({ ...data, version: bc.evmEnabled ? '5.0' : '4.0',
                    ...(bc.evmEnabled ? { evmProtocol: bc.consensus.evm, evmConsensusHash: bc.consensus.evmFingerprint,
                        evmStateRoot: snapshot?.evmStateRoot || bc._evaluation.evmStateRoot } : {}),
                    consensusHash: bc.consensus.fingerprint, savedAt: new Date().toISOString() }, null, 2));
                fs.fsyncSync(fd);
            } finally { fs.closeSync(fd); }
            fs.renameSync(temporary, bc.dataFile);
            return true;
        } catch (error) {
            this.log.error('链保存失败', { error: error.message });
            try { fs.unlinkSync(temporary); } catch { /* No temporary file may exist. */ }
            return false;
        }
    }

    clearDataFile() {
        const bc = this.blockchain;
        if (bc.consensus.params.activationHeight > 1) throw new Error('迁移链不能重置到检查点之前');
        const result = bc.evaluateChain([bc.createGenesisBlock()]);
        // Persist a valid reset before changing memory.
        bc.commitEvaluation(result, [], { revertedTransactions: new Map(), reorgEvents: [] });
        return true;
    }
}
module.exports = { StorageManager };
