// Read-only audit. This never repairs, re-signs or rewrites chain data.
const fs = require('fs');
const path = require('path');
const { Blockchain } = require('../src/blockchain/blockchain');
const { Consensus } = require('../src/consensus');

function auditChain(saved, overrides = {}) {
    const genesis = new Blockchain(0, true, { consensus: overrides }).createGenesisBlock();
    const legacy = Array.isArray(saved.chain) && saved.chain.slice(1).every(b => (b.version ?? 1) === 1);
    const params = legacy && saved.chain.length > 1 ? {
        ...overrides, activationHeight: saved.chain.length,
        legacyCheckpointHash: saved.chain.at(-1).hash
    } : overrides;
    const consensus = new Consensus(genesis, params);
    const result = saved.version === '4.0' && saved.consensusHash !== consensus.fingerprint
        ? { valid: false, index: 0, error: '本地链共识参数不匹配' }
        : consensus.evaluate(saved.chain);
    return { valid: result.valid, invalidBlock: result.valid ? null : result.index,
        error: result.error || null, blocks: saved.chain?.length || 0,
        chainWork: result.valid ? result.work.toString() : null,
        consensus: consensus.params, consensusHash: consensus.fingerprint,
        migration: legacy && result.valid ? { PROTOCOL_ACTIVATION_HEIGHT: consensus.params.activationHeight,
            LEGACY_CHECKPOINT_HASH: consensus.params.legacyCheckpointHash,
            CHAIN_ID: consensus.params.chainId } : null };
}

if (require.main === module) {
    try {
        const filename = process.argv[2];
        if (!filename) throw new Error('用法：node scripts/audit-chain.js <链文件.json> [报告.json]');
        const report = auditChain(JSON.parse(fs.readFileSync(path.resolve(filename), 'utf8')));
        const text = JSON.stringify(report, null, 2);
        if (process.argv[3]) fs.writeFileSync(path.resolve(process.argv[3]), text + '\n');
        console.log(text);
        process.exitCode = report.valid ? 0 : 1;
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { auditChain };
