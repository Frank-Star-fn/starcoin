const fs = require('fs');
const path = require('path');
const { rpcSettings } = require('./rpc-settings');
const { EvmConsensus } = require('./consensus');

async function rpcNetworkSettings(consensus, directory) {
    const file = path.join(directory, 'metamask-network.json');
    const read = () => {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved.evmConsensusHash !== consensus.evmFingerprint) throw new Error('MetaMask 配置与 EVM 网络不匹配');
        return rpcSettings(saved.rpc);
    };
    if (fs.existsSync(file)) return read();
    let recovered = null, best = null;
    const snapshots = [];
    if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory).filter(name => /^blockchain_[0-9]+\.json$/.test(name))) {
        const saved = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        if (saved.consensusHash !== consensus.fingerprint || (saved.evmConsensusHash && saved.evmConsensusHash !== consensus.evmFingerprint)) throw new Error('MetaMask 升级发现不匹配的链：' + name);
        if (saved.version === '6.0') {
            const rpc = rpcSettings(saved.rpcProtocol);
            if (!rpc || (recovered && recovered.fingerprint !== rpc.fingerprint)) throw new Error('MetaMask 配置不一致');
            recovered = rpc;
        }
        snapshots.push({ name, saved });
    }
    const audit = recovered ? new EvmConsensus(consensus.genesis, consensus.params, consensus.evm, recovered) : consensus;
    for (const { name, saved } of snapshots) {
        const result = await audit.evaluateAsync(saved.chain);
        if (!result.valid || (saved.evmStateRoot && saved.evmStateRoot !== result.evmStateRoot)
            || (saved.version === '6.0' && saved.rpcConsensusHash !== audit.rpcFingerprint)) throw new Error('MetaMask 升级审计失败：' + name + '，' + (result.error || '配置或状态根不匹配'));
        if (!best || result.work > best.work) best = result;
    }
    if (!recovered && consensus.evm.activationHeight > (best?.blocks.length || 1)) throw new Error('须从完整节点复制 metamask-network.json，并先同步升级检查点');
    const rpc = recovered || rpcSettings({ activationHeight: best?.blocks.length || 1,
        checkpointHash: best?.blocks.at(-1).hash || '', initialBaseFeeWei: consensus.evm.gasPriceWei });
    fs.mkdirSync(directory, { recursive: true });
    const temp = file + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
    try {
        fs.writeFileSync(temp, JSON.stringify({ evmConsensusHash: consensus.evmFingerprint, rpc }, null, 2), { flag: 'wx' });
        try { fs.linkSync(temp, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return read();
}
module.exports = { rpcNetworkSettings };
