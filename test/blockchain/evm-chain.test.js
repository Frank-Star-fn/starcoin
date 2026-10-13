const fs = require('fs');
const os = require('os');
const path = require('path');
const { EvmBlockchain } = require('../../src/evm/blockchain');
const { evmAddressFromPem, WEI_PER_UNIT } = require('../../src/evm/engine');
const { generateWallet } = require('../../src/core');
const { restoreBlock } = require('../../src/consensus');
const native = { initialDifficulty: 1, difficultyMin: 0, coinbaseMaturity: 0, difficultyAdjustInterval: 1000000,
    activationHeight: 1, legacyCheckpointHash: '' };
const bytecode = '0x6017600c60003960176000f33615600b576000356000555b60005460005260206000f3';

async function chainFor(options = {}, persistent = false) {
    const chain = new EvmBlockchain(45001, !persistent, { consensus: native, evm: { activationHeight: 1 }, ...options });
    await chain.ready;
    return chain;
}

async function deployed(chain, wallet) {
    await chain.mineBlock(wallet.address);
    await chain.submitEvm(wallet.privateKey, { kind: 'deposit', amount: '10' });
    await chain.mineBlock(wallet.address);
    const deployment = await chain.submitEvm(wallet.privateKey, { data: bytecode });
    await chain.mineBlock(wallet.address);
    return chain.receipt(deployment.id).contractAddress;
}

describe('v3 EVM consensus', () => {
    it('confirms deposits, contract writes and withdrawals with exact accounting', async () => {
        const chain = await chainFor(), wallet = generateWallet(), source = evmAddressFromPem(wallet.privateKey);
        const contract = await deployed(chain, wallet);
        expect(contract).toMatch(/^0x[0-9a-f]{40}$/);
        const write = await chain.submitEvm(wallet.privateKey, { to: contract, data: '0x' + '00'.repeat(31) + '07' });
        expect(await chain._evaluation.engine.storage(contract, '0')).toBe('0x' + '0'.repeat(64));
        await chain.mineBlock(wallet.address);
        const receipt = chain.receipt(write.id);
        expect(receipt.status).toBe(1);
        expect(await chain._evaluation.engine.storage(contract, '0')).toBe('0x' + '0'.repeat(63) + '7');
        const beforeNative = chain.getBalance(wallet.address), beforeEvm = await chain._evaluation.engine.balance(source);
        await chain.submitEvm(wallet.privateKey, { kind: 'withdraw', amount: '1.00000001' });
        await chain.mineBlock(wallet.address);
        expect(chain.getBalance(wallet.address)).toBe(beforeNative + 50 + 1.00000001);
        expect(await chain._evaluation.engine.balance(source)).toBe(beforeEvm - 100000001n * WEI_PER_UNIT);
        const replay = await chain.consensus.evaluateAsync(JSON.parse(JSON.stringify(chain.chain)));
        expect(replay.valid).toBe(true);
        expect(replay.evmStateRoot).toBe(chain._evaluation.evmStateRoot);
    });

    it('includes failed EVM execution, burns gas, advances nonces and keeps reverted state', async () => {
        const chain = await chainFor(), wallet = generateWallet();
        await chain.mineBlock(wallet.address);
        await chain.submitEvm(wallet.privateKey, { kind: 'deposit', amount: '2' });
        await chain.mineBlock(wallet.address);
        const failed = await chain.submitEvm(wallet.privateKey, { data: '0x60006000fd' });
        await chain.mineBlock(wallet.address);
        expect(chain.receipt(failed.id).status).toBe(0);
        expect(chain.receipt(failed.id).logs).toEqual([]);
        expect(await chain._evaluation.engine.nonce(evmAddressFromPem(wallet.privateKey))).toBe(1n);
        expect(chain.query.getConfirmedNonce(wallet.address)).toBe(2);
        expect(chain.getTotalBurnedFees()).toBeGreaterThan(0);
    });

    it('rejects altered execution roots even with recomputed valid PoW', async () => {
        const chain = await chainFor(), wallet = generateWallet();
        await chain.mineBlock(wallet.address);
        const { block } = await chain.buildCandidate(wallet.address);
        block.evmStateRoot = '0x' + 'f'.repeat(64);
        block.hash = block.calculateHash(); block.mineBlock(chain.difficulty);
        expect(await chain.addBlock(block)).toBeNull();
        expect(chain.chain).toHaveLength(2);
        const wrongReceipts = (await chain.buildCandidate(wallet.address)).block;
        wrongReceipts.receiptsRoot = 'e'.repeat(64);
        wrongReceipts.hash = wrongReceipts.calculateHash(); wrongReceipts.mineBlock(chain.difficulty);
        expect(await chain.addBlock(wrongReceipts)).toBeNull();
    });

    it('rejects a forged bridge recipient and duplicate native nonce', async () => {
        const chain = await chainFor(), wallet = generateWallet();
        await chain.mineBlock(wallet.address);
        const deposit = await chain.submitEvm(wallet.privateKey, { kind: 'deposit', amount: '1' });
        const forged = JSON.parse(JSON.stringify(deposit));
        forged.evmAddress = '0x' + 'e'.repeat(40);
        await expect(chain.addTransaction(forged)).rejects.toThrow();
        await expect(chain.addTransaction(deposit)).rejects.toThrow();
        expect(chain.pendingTransactions).toHaveLength(1);
        expect(await chain._evaluation.engine.balance(evmAddressFromPem(wallet.privateKey))).toBe(0n);
    });

    it('restores the new branch state and returns rolled-back contract transactions to the pool', async () => {
        const first = await chainFor(), second = await chainFor(), wallet = generateWallet();
        const contract = await deployed(first, wallet);
        const baseline = await first.submitEvm(wallet.privateKey, { to: contract, data: '0x' + '00'.repeat(31) + '07' });
        await first.mineBlock(wallet.address);
        expect(await second.replaceChain(first.chain)).toBe(true);
        const reverted = await first.submitEvm(wallet.privateKey, { to: contract, data: '0x' + '00'.repeat(31) + '09' });
        await first.mineBlock(wallet.address);
        await second.mineBlock(wallet.address); await second.mineBlock(wallet.address);
        expect(await first.replaceChain(second.chain)).toBe(true);
        expect(await first._evaluation.engine.storage(contract, '0')).toBe('0x' + '0'.repeat(63) + '7');
        expect(first.receipt(baseline.id).status).toBe(1);
        expect(first.receipt(reverted.id).wasReverted).toBe(true);
        expect(first.pendingTransactions.some(tx => tx.id === reverted.id)).toBe(true);
    });

    it('keeps confirmed state unchanged when persistence fails', async () => {
        const chain = await chainFor(), wallet = generateWallet();
        await chain.mineBlock(wallet.address);
        const deposit = await chain.submitEvm(wallet.privateKey, { kind: 'deposit', amount: '1' });
        const root = chain._evaluation.evmStateRoot, length = chain.chain.length;
        vi.spyOn(chain.storage, 'saveToFile').mockReturnValue(false);
        await expect(chain.mineBlock(wallet.address)).rejects.toThrow('持久化');
        expect(chain.chain.length).toBe(length);
        expect(chain._evaluation.evmStateRoot).toBe(root);
        expect(chain.hasPendingTransaction(deposit.id)).toBe(true);
    });

    it('replays persisted code/storage and validates snapshot roots after restart', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'starcoin-evm-restart-'));
        const dataFile = path.join(directory, 'blockchain_45001.json');
        try {
            const first = await chainFor({ dataFile }, true), wallet = generateWallet();
            const contract = await deployed(first, wallet);
            const tx = await first.submitEvm(wallet.privateKey, { to: contract, data: '0x' + '00'.repeat(31) + '08' });
            await first.mineBlock(wallet.address);
            const restored = await chainFor({ dataFile }, true);
            expect(restored._evaluation.evmStateRoot).toBe(first._evaluation.evmStateRoot);
            expect(await restored._evaluation.engine.storage(contract, '0')).toBe('0x' + '0'.repeat(63) + '8');
            expect(restored.receipt(tx.id).status).toBe(1);
            const bad = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
            bad.evmStateRoot = '0x' + 'f'.repeat(64); fs.writeFileSync(dataFile, JSON.stringify(bad));
            const corrupt = new EvmBlockchain(45001, false, { consensus: native, evm: {}, dataFile });
            await expect(corrupt.ready).rejects.toThrow('状态根');
            expect(JSON.parse(fs.readFileSync(dataFile, 'utf8')).evmStateRoot).toBe(bad.evmStateRoot);
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });

    it('preserves legacy block hashes across an explicit activation checkpoint', async () => {
        const legacy = require('../helpers').newFreshChain();
        const wallet = generateWallet(); legacy.mineBlock(wallet.address);
        const chain = await chainFor({ consensus: legacy.consensus.params,
            evm: { activationHeight: 2, checkpointHash: legacy.getLatestBlock().hash } });
        expect(await chain.replaceChain(legacy.chain)).toBe(true);
        expect(chain.chain[1].hash).toBe(legacy.chain[1].hash);
        await chain.mineBlock(wallet.address);
        expect(chain.getLatestBlock().version).toBe(3);
        expect((await chain.consensus.evaluateAsync(chain.chain)).valid).toBe(true);
        const old = restoreBlock(JSON.parse(JSON.stringify(legacy.chain[1])));
        expect(old.calculateHash()).toBe(old.hash);
    });
});
