const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet } = require('ethers');
const { EvmBlockchain } = require('../../src/evm/blockchain');
const { generateWallet } = require('../../src/core');
const { rpcNetworkSettings } = require('../../src/evm/rpc-network');
const native = { activationHeight: 1, legacyCheckpointHash: '', initialDifficulty: 1, difficultyMin: 0,
    coinbaseMaturity: 0, difficultyAdjustInterval: 1000000 };
describe('MetaMask snapshot upgrade', () => {
    it('freezes a v3 checkpoint, backs up original files and replays signed transactions after restart', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'starcoin-metamask-network-'));
        try {
            const file = path.join(directory, 'blockchain_45100.json'), wallet = generateWallet(), external = Wallet.createRandom();
            const old = new EvmBlockchain(45100, false, { dataFile: file, consensus: native, evm: { activationHeight: 1 }, rpc: null }); await old.ready;
            await old.mineBlock(wallet.address); await old.submitEvm(wallet.privateKey, { kind: 'deposit', amount: '2', evmAddress: external.address }); await old.mineBlock(wallet.address);
            const original = fs.readFileSync(file, 'utf8'), hashes = old.chain.map(block => block.hash);
            const settings = await rpcNetworkSettings(old.consensus, directory);
            expect(settings.activationHeight).toBe(hashes.length); expect(settings.checkpointHash).toBe(hashes.at(-1));
            const upgraded = new EvmBlockchain(45100, false, { dataFile: file, consensus: native, evm: { activationHeight: 1 } }); await upgraded.ready;
            expect(fs.readFileSync(file + '.pre-metamask.json', 'utf8')).toBe(original);
            const signed = await external.signTransaction({ type: 2, chainId: 155001, nonce: 0, to: Wallet.createRandom().address,
                value: 123n, gasLimit: 21000, maxFeePerGas: 30000000000n, maxPriorityFeePerGas: 1000000000n });
            const tx = await upgraded.submitRaw(signed); await upgraded.mineBlock(wallet.address);
            expect(upgraded.chain.slice(0, hashes.length).map(block => block.hash)).toEqual(hashes);
            expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe('6.0');
            const restarted = new EvmBlockchain(45100, false, { dataFile: file, consensus: native, evm: { activationHeight: 1 } }); await restarted.ready;
            expect(restarted._evaluation.evmStateRoot).toBe(upgraded._evaluation.evmStateRoot); expect(restarted.receipt(tx.id).status).toBe(1);
            const tampered = JSON.parse(fs.readFileSync(file, 'utf8')); tampered.rpcConsensusHash = 'f'.repeat(64); fs.writeFileSync(file, JSON.stringify(tampered));
            const broken = new EvmBlockchain(45100, false, { dataFile: file, consensus: native, evm: { activationHeight: 1 } });
            await expect(broken.ready).rejects.toThrow(/MetaMask/);
            expect(JSON.parse(fs.readFileSync(file, 'utf8')).rpcConsensusHash).toBe('f'.repeat(64));
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
});
