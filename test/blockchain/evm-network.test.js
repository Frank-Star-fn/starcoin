const fs = require('fs');
const os = require('os');
const path = require('path');
const { Blockchain } = require('../../src/blockchain/blockchain');
const { EvmBlockchain } = require('../../src/evm/blockchain');
const { networkSettings } = require('../../src/evm/network');
const { generateWallet } = require('../../src/core');
const native = { initialDifficulty: 1, difficultyMin: 0, coinbaseMaturity: 0, difficultyAdjustInterval: 1000000, activationHeight: 1 };

describe('EVM network upgrade', () => {
    it('audits multiple native snapshots, freezes one checkpoint and preserves originals', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'starcoin-evm-upgrade-'));
        try {
            const old = new Blockchain(45030, true, { consensus: native }), wallet = generateWallet();
            old.mineBlock(wallet.address); const behind = JSON.parse(JSON.stringify(old.chain)); old.mineBlock(wallet.address);
            const save = (port, chain) => fs.writeFileSync(path.join(directory, 'blockchain_' + port + '.json'), JSON.stringify({
                version: '4.0', consensusHash: old.consensus.fingerprint, chain, pendingTransactions: [] }));
            save(45030, old.chain); save(45031, behind);
            const original = fs.readFileSync(path.join(directory, 'blockchain_45030.json'), 'utf8');
            const settings = networkSettings(old.consensus, directory);
            expect(settings.activationHeight).toBe(3); expect(settings.checkpointHash).toBe(old.getLatestBlock().hash);
            const first = new EvmBlockchain(45030, false, { consensus: native, dataFile: path.join(directory, 'blockchain_45030.json') });
            const second = new EvmBlockchain(45031, false, { consensus: native, dataFile: path.join(directory, 'blockchain_45031.json') });
            await Promise.all([first.ready, second.ready]);
            expect(first.consensus.evmFingerprint).toBe(second.consensus.evmFingerprint);
            expect(fs.readFileSync(first.dataFile, 'utf8')).toBe(original);
            expect(fs.readFileSync(first.dataFile + '.pre-evm.json', 'utf8')).toBe(original);
            await first.submitEvm(wallet.privateKey, { kind: 'deposit', amount: '1' }); await first.mineBlock(wallet.address);
            expect(await second.replaceChain(first.chain)).toBe(true);
            expect(second._evaluation.evmStateRoot).toBe(first._evaluation.evmStateRoot);
            const restored = new EvmBlockchain(45031, false, { consensus: native, dataFile: second.dataFile }); await restored.ready;
            expect(restored._evaluation.evmStateRoot).toBe(first._evaluation.evmStateRoot);
            const different = new EvmBlockchain(45032, true, { consensus: native, evm: { ...settings, chainId: settings.chainId + 1 } }); await different.ready;
            expect(await different.isChainValid(first.chain)).toBe(false);
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
});
