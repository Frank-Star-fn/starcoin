const fs = require('fs');
const path = require('path');
const { evmSettings } = require('./settings');

function networkSettings(nativeConsensus, directory) {
    const networkFile = path.join(directory, 'evm-network.json');
    const read = () => {
        const saved = JSON.parse(fs.readFileSync(networkFile, 'utf8'));
        if (saved.nativeConsensusHash !== nativeConsensus.fingerprint) throw new Error('EVM 网络配置与原生共识不匹配');
        const settings = evmSettings(saved.evm);
        if (process.env.EVM_CHAIN_ID && Number(process.env.EVM_CHAIN_ID) !== settings.chainId) throw new Error('EVM_CHAIN_ID 与升级配置不匹配');
        return settings;
    };
    if (fs.existsSync(networkFile)) return read();
    let best = null, recovered = null;
    if (fs.existsSync(directory)) {
        for (const file of fs.readdirSync(directory).filter(name => /^blockchain_[0-9]+\.json$/.test(name))) {
            const saved = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
            if (saved.consensusHash && saved.consensusHash !== nativeConsensus.fingerprint) throw new Error('升级审计发现共识配置不同的链：' + file);
            if (['5.0', '6.0'].includes(saved.version)) {
                const settings = evmSettings(saved.evmProtocol);
                if (recovered && recovered.fingerprint !== settings.fingerprint) throw new Error('已保存的 EVM 网络配置不一致');
                recovered = settings;
            } else {
                const result = nativeConsensus.evaluate(saved.chain);
                if (!result.valid) throw new Error('升级审计失败：' + file + '，' + result.error);
                if (!best || result.work > best.work) best = result;
            }
        }
    }
    const evm = recovered || evmSettings({ chainId: Number(process.env.EVM_CHAIN_ID || 155001),
        activationHeight: best?.blocks.length || 1, checkpointHash: best?.blocks.at(-1).hash || '' });
    fs.mkdirSync(directory, { recursive: true });
    const temporary = networkFile + '.' + process.pid + '.tmp';
    try {
        fs.writeFileSync(temporary, JSON.stringify({ nativeConsensusHash: nativeConsensus.fingerprint, evm }, null, 2));
        try { fs.linkSync(temporary, networkFile); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return read();
}

module.exports = { networkSettings };
