const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../../src/config');
const { Blockchain } = require('../../src/blockchain/blockchain');
const { EvmBlockchain } = require('../../src/evm/blockchain');
const { generateWallet } = require('../../src/core');
const { Wallet } = require('ethers');

const native = { initialDifficulty: 0, difficultyMin: 0, coinbaseMaturity: 0,
    difficultyAdjustInterval: 1000000, activationHeight: 1, legacyCheckpointHash: '' };
const settings = ['MEMPOOL_MAX_TXS', 'MEMPOOL_MAX_BYTES', 'MEMPOOL_MAX_PER_ADDRESS', 'P2P_MAX_PAYLOAD'];
const size = transactions => Buffer.byteLength(JSON.stringify(transactions), 'utf8');
async function chainFor(kind, dataFile) {
    const options = { consensus: native, ...(dataFile ? { dataFile } : {}) };
    const chain = kind === 'native' ? new Blockchain(45980, !dataFile, options)
        : new EvmBlockchain(45980, !dataFile, { ...options, evm: {}, rpc: { activationHeight: 1 } });
    if (chain.ready) await chain.ready;
    return chain;
}
async function setup(kind, dataFile) {
    const chain = await chainFor(kind, dataFile), alice = generateWallet(), bob = generateWallet();
    await chain.mineBlock(alice.address); await chain.mineBlock(bob.address);
    return { chain, alice, bob };
}
function transfer(chain, wallet, nonce, note = '') {
    const tx = chain.createTransaction(wallet.address, 'a'.repeat(32), '1', '0', note, 'STC', nonce);
    tx.signTransaction(wallet.privateKey, wallet.publicKey);
    return tx;
}

describe('local mempool resource limits', () => {
    let original;
    beforeEach(() => {
        original = Object.fromEntries(settings.map(key => [key, config[key]]));
        Object.assign(config, { MEMPOOL_MAX_TXS: 3, MEMPOOL_MAX_BYTES: 8 * 1024 * 1024, MEMPOOL_MAX_PER_ADDRESS: 2 });
    });
    afterEach(() => Object.assign(config, original));

    it.each(['native', 'evm'])('%s rejects a full pool before replay without changing reservations', async kind => {
        const { chain, alice, bob } = await setup(kind);
        config.MEMPOOL_MAX_TXS = 2;
        await chain.addTransaction(transfer(chain, alice, 0)); await chain.addTransaction(transfer(chain, bob, 0));
        const pending = chain.pendingTransactions, state = chain._poolState, engine = chain._poolEngine;
        const replay = vi.spyOn(chain.consensus, kind === 'evm' ? 'rebuildPoolAsync' : 'rebuildPool');
        await expect(Promise.resolve().then(() => chain.addTransaction(transfer(chain, alice, 1))))
            .rejects.toMatchObject({ code: 'MEMPOOL_FULL', statusCode: 429 });
        expect(replay).not.toHaveBeenCalled();
        expect(chain.pendingTransactions).toBe(pending); expect(chain._poolState).toBe(state); expect(chain._poolEngine).toBe(engine);
        replay.mockRestore();
        await chain.mineBlock(bob.address);
        await chain.addTransaction(transfer(chain, alice, 1));
        expect(chain.pendingTransactions).toHaveLength(1);
    });

    it.each(['native', 'evm'])('%s limits one sender while allowing a different sender', async kind => {
        const { chain, alice, bob } = await setup(kind);
        config.MEMPOOL_MAX_TXS = 4;
        await chain.addTransaction(transfer(chain, alice, 0)); await chain.addTransaction(transfer(chain, alice, 1));
        await expect(Promise.resolve().then(() => chain.addTransaction(transfer(chain, alice, 2))))
            .rejects.toMatchObject({ code: 'MEMPOOL_SENDER_LIMIT' });
        await chain.addTransaction(transfer(chain, bob, 0));
        expect(chain.pendingTransactions).toHaveLength(3);
    });

    it.each(['native', 'evm'])('%s counts UTF-8 bytes and accepts the exact array boundary', async kind => {
        const { chain, alice } = await setup(kind), tx = transfer(chain, alice, 0, '界'.repeat(30));
        config.MEMPOOL_MAX_BYTES = size([tx]);
        await chain.addTransaction(tx);
        await expect(Promise.resolve().then(() => chain.addTransaction(transfer(chain, alice, 1))))
            .rejects.toMatchObject({ code: 'MEMPOOL_BYTES_FULL' });
        expect(chain.pendingTransactions).toEqual([tx]);
    });

    it.each(['native', 'evm'])('%s rejects an individually unsendable transaction', async kind => {
        const { chain, alice } = await setup(kind);
        config.P2P_MAX_PAYLOAD = 4096;
        await expect(Promise.resolve().then(() => chain.addTransaction(transfer(chain, alice, 0, '界'.repeat(1000)))))
            .rejects.toMatchObject({ code: 'TRANSACTION_TOO_LARGE', statusCode: 413 });
        expect(chain.pendingTransactions).toHaveLength(0);
        await chain.addTransaction(transfer(chain, alice, 0));
        expect(chain.pendingTransactions).toHaveLength(1);
    });

    it.each(['native', 'evm'])('%s rebuilds within limits without reserving rejected transactions', async kind => {
        const { chain, alice, bob } = await setup(kind);
        config.MEMPOOL_MAX_TXS = 4;
        const candidates = [transfer(chain, alice, 0), transfer(chain, alice, 1), transfer(chain, alice, 2), transfer(chain, bob, 0)];
        const evaluation = await chain.evaluateChain();
        const pool = kind === 'evm' ? await chain.consensus.rebuildPoolAsync(evaluation, candidates)
            : chain.consensus.rebuildPool(evaluation, candidates);
        expect(pool.pending.map(tx => tx.id).sort()).toEqual([candidates[0].id, candidates[1].id, candidates[3].id].sort());
        expect(pool.rejected).toContainEqual(expect.objectContaining({ id: candidates[2].id, code: 'MEMPOOL_SENDER_LIMIT' }));
        expect(pool.state.nonces.get(alice.address)).toBe(2); expect(pool.state.ids.has(candidates[2].id)).toBe(false);
    });

    it.each(['native', 'evm'])('%s applies local limits after restart, preserving the confirmed chain', async kind => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-mempool-')), file = path.join(directory, 'chain.json');
        try {
            const { chain, alice, bob } = await setup(kind, file);
            await chain.addTransaction(transfer(chain, alice, 0)); await chain.addTransaction(transfer(chain, bob, 0));
            await chain.saveToFile(); const hash = chain.getLatestBlock().hash;
            config.MEMPOOL_MAX_TXS = 1;
            const restored = await chainFor(kind, file);
            expect(restored.pendingTransactions).toHaveLength(1);
            expect(restored.getLatestBlock().hash).toBe(hash); expect(await restored.isChainValid()).toBe(true);
        } finally { if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(directory); }
    });

    it.each(['native', 'evm'])('%s accepts valid blocks exceeding the local pool limit', async kind => {
        const { chain, alice } = await setup(kind), fork = await chainFor(kind);
        await fork.replaceChain(chain.chain);
        config.MEMPOOL_MAX_TXS = 10; config.MEMPOOL_MAX_PER_ADDRESS = 10;
        for (let nonce = 0; nonce < 3; nonce++) await fork.addTransaction(transfer(fork, alice, nonce));
        await fork.mineBlock(alice.address);
        config.MEMPOOL_MAX_TXS = 1; config.MEMPOOL_MAX_PER_ADDRESS = 1;
        expect(await chain.addBlock(fork.getLatestBlock())).toBeTruthy();
        expect(await chain.isChainValid()).toBe(true); expect(chain.pendingTransactions).toHaveLength(0);
    });

    it.each(['native', 'evm'])('%s keeps an existing full pool when orphaned transactions return', async kind => {
        const { chain, alice, bob } = await setup(kind), fork = await chainFor(kind);
        await fork.replaceChain(chain.chain); config.MEMPOOL_MAX_TXS = 1;
        const orphan = transfer(chain, alice, 0); await chain.addTransaction(orphan); await chain.mineBlock(alice.address);
        const pending = transfer(chain, bob, 0); await chain.addTransaction(pending);
        await fork.mineBlock(bob.address); await fork.mineBlock(bob.address);
        expect(await chain.replaceChain(fork.chain)).toBe(true);
        expect(chain.pendingTransactions).toEqual([pending]); expect(chain.revertedTransactions.has(orphan.id)).toBe(true);
    });

    it('rejects the 1001st valid EVM-chain transaction without replaying 1000 entries', async () => {
        const { chain, alice } = await setup('evm');
        config.MEMPOOL_MAX_TXS = 1000; config.MEMPOOL_MAX_PER_ADDRESS = 2000;
        const transactions = Array.from({ length: 1000 }, (_, nonce) => {
            const tx = chain.createTransaction(alice.address, 'a'.repeat(32), '0.00000001', '0', '', 'STC', nonce);
            tx.signTransaction(alice.privateKey, alice.publicKey); return tx;
        });
        const pool = await chain.consensus.rebuildPoolAsync(chain._evaluation, transactions);
        expect(pool.pending).toHaveLength(1000);
        chain.pendingTransactions = pool.pending; chain._poolState = pool.state; chain._poolEngine = pool.engine;
        const replay = vi.spyOn(chain.consensus, 'rebuildPoolAsync');
        await expect(chain.addTransaction(transfer(chain, alice, 1000))).rejects.toMatchObject({ code: 'MEMPOOL_FULL' });
        expect(replay).not.toHaveBeenCalled(); expect(chain.pendingTransactions).toHaveLength(1000);
    });

    it('serializes concurrent admissions at the last free slot', async () => {
        const { chain, alice, bob } = await setup('evm'); config.MEMPOOL_MAX_TXS = 1;
        const results = await Promise.allSettled([chain.addTransaction(transfer(chain, alice, 0)), chain.addTransaction(transfer(chain, bob, 0))]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.find(result => result.status === 'rejected').reason.code).toBe('MEMPOOL_FULL');
        expect(chain.pendingTransactions).toHaveLength(1);
    });

    it('allows a higher-fee replacement in a full pool and keeps the original if replacement exceeds bytes', async () => {
        const { chain, alice } = await setup('evm'), wallet = Wallet.createRandom();
        await chain.submitEvm(alice.privateKey, { kind: 'deposit', amount: '10', evmAddress: wallet.address });
        await chain.mineBlock(alice.address);
        config.MEMPOOL_MAX_TXS = 1; config.MEMPOOL_MAX_PER_ADDRESS = 1;
        const raw = options => wallet.signTransaction({ type: 2, chainId: chain.consensus.evm.chainId,
            nonce: 0, to: wallet.address, gasLimit: 30000, maxFeePerGas: 30000000000n, maxPriorityFeePerGas: 1000000000n, ...options });
        const first = await chain.submitRaw(await raw());
        config.MEMPOOL_MAX_BYTES = size([first]);
        const root = await chain._poolEngine.root();
        await expect(chain.submitRaw(await raw({ data: '0x' + '01'.repeat(100), maxFeePerGas: 40000000000n, maxPriorityFeePerGas: 2000000000n })))
            .rejects.toMatchObject({ code: 'MEMPOOL_BYTES_FULL' });
        expect(chain.pendingTransactions).toEqual([first]); expect(await chain._poolEngine.root()).toBe(root);
        config.MEMPOOL_MAX_BYTES = original.MEMPOOL_MAX_BYTES;
        const replacement = await chain.submitRaw(await raw({ maxFeePerGas: 40000000000n, maxPriorityFeePerGas: 2000000000n }));
        expect(chain.pendingTransactions).toEqual([replacement]); expect(await chain._poolEngine.nonce(wallet.address)).toBe(1n);
    });
});
