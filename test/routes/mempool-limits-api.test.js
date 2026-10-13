const express = require('express');
const request = require('supertest');
const { Wallet } = require('ethers');
const config = require('../../src/config');
const { generateWallet } = require('../../src/core');
const { EvmBlockchain } = require('../../src/evm/blockchain');
const { EvmTransaction } = require('../../src/evm/transaction');
const { newFreshChain, createMockP2P } = require('../helpers');
const createTxRoutes = require('../../src/routes/api-tx');
const createEvmRoutes = require('../../src/routes/api-evm');
const createRpc = require('../../src/rpc');

function appFor(chain) {
    const p2p = createMockP2P(), broadcast = vi.fn(), app = express();
    p2p.broadcastTransaction = vi.fn();
    app.use('/rpc', createRpc(chain, p2p, broadcast)); app.use(express.json());
    app.use('/api', createTxRoutes(chain, broadcast, p2p)); app.use('/api', createEvmRoutes(chain, p2p, broadcast));
    return { app, p2p, broadcast };
}
async function setup(modern = false) {
    const chain = modern ? new EvmBlockchain(45990, true, { consensus: { initialDifficulty: 0, difficultyMin: 0,
        coinbaseMaturity: 0, difficultyAdjustInterval: 1000000, activationHeight: 1 }, rpc: { activationHeight: 1 } }) : newFreshChain();
    if (chain.ready) await chain.ready;
    const wallet = generateWallet(); await chain.mineBlock(wallet.address);
    return { chain, wallet, ...appFor(chain) };
}
function sign(chain, wallet, nonce, note = '') {
    const tx = chain.createTransaction(wallet.address, 'a'.repeat(32), '1', '0', note, 'STC', nonce);
    tx.signTransaction(wallet.privateKey, wallet.publicKey); return tx;
}

describe('mempool capacity errors across public APIs', () => {
    let original;
    beforeEach(() => {
        const keys = ['MEMPOOL_MAX_TXS', 'MEMPOOL_MAX_BYTES', 'MEMPOOL_MAX_PER_ADDRESS', 'P2P_MAX_PAYLOAD'];
        original = Object.fromEntries(keys.map(key => [key, config[key]]));
        config.MEMPOOL_MAX_TXS = 1;
    });
    afterEach(() => Object.assign(config, original));

    it.each([false, true])('returns a capacity error and does not broadcast rejected native transactions, EVM=%s', async modern => {
        const ctx = await setup(modern);
        await request(ctx.app).post('/api/transaction/signed').send({ transaction: sign(ctx.chain, ctx.wallet, 0) }).expect(200);
        const rejected = await request(ctx.app).post('/api/transaction/signed').send({ transaction: sign(ctx.chain, ctx.wallet, 1) }).expect(429);
        expect(rejected.body.code).toBe('MEMPOOL_FULL'); expect(ctx.chain.pendingTransactions).toHaveLength(1);
        expect(ctx.p2p.broadcastTransaction).toHaveBeenCalledTimes(1); expect(ctx.broadcast).toHaveBeenCalledTimes(1);
    });

    it('returns 413 for an individually unsendable transaction', async () => {
        const ctx = await setup(); config.P2P_MAX_PAYLOAD = 4096;
        const rejected = await request(ctx.app).post('/api/transaction/signed')
            .send({ transaction: sign(ctx.chain, ctx.wallet, 0, '界'.repeat(1000)) }).expect(413);
        expect(rejected.body.code).toBe('TRANSACTION_TOO_LARGE'); expect(ctx.p2p.broadcastTransaction).not.toHaveBeenCalled();
    });

    it('uses the same capacity error for browser-signed EVM deposits', async () => {
        const ctx = await setup(true); await ctx.chain.addTransaction(sign(ctx.chain, ctx.wallet, 0));
        const address = new Wallet(require('../../src/front/wallet-crypto').rawFromPem(ctx.wallet.privateKey)).address.toLowerCase();
        const tx = new EvmTransaction({ chainId: ctx.chain.consensus.params.chainId, kind: 'deposit',
            from: ctx.wallet.address, to: 'EVM:' + address, amount: '1', nonce: 1, evmAddress: address });
        tx.signTransaction(ctx.wallet.privateKey, ctx.wallet.publicKey);
        const rejected = await request(ctx.app).post('/api/evm/signed').send({ transaction: tx }).expect(429);
        expect(rejected.body.code).toBe('MEMPOOL_FULL'); expect(ctx.p2p.broadcastTransaction).not.toHaveBeenCalled();
    });

    it('returns REST and RPC capacity errors for raw EVM transactions, with nonce unchanged', async () => {
        const ctx = await setup(true), external = Wallet.createRandom();
        await ctx.chain.submitEvm(ctx.wallet.privateKey, { kind: 'deposit', amount: '10', evmAddress: external.address });
        await ctx.chain.mineBlock(ctx.wallet.address);
        const raw = nonce => external.signTransaction({ type: 2, chainId: ctx.chain.consensus.evm.chainId, nonce,
            to: external.address, gasLimit: 21000, maxFeePerGas: 30000000000n, maxPriorityFeePerGas: 1000000000n });
        await request(ctx.app).post('/api/evm/raw').send({ rawTransaction: await raw(0) }).expect(200);
        const pending = await raw(1);
        const rest = await request(ctx.app).post('/api/evm/raw').send({ rawTransaction: pending }).expect(429);
        expect(rest.body.code).toBe('MEMPOOL_FULL');
        const rpc = await request(ctx.app).post('/rpc').send({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [pending] }).expect(200);
        expect(rpc.body.error).toMatchObject({ code: -32005, data: { code: 'MEMPOOL_FULL' } });
        expect(await ctx.chain._poolEngine.nonce(external.address)).toBe(1n); expect(ctx.p2p.broadcastTransaction).toHaveBeenCalledTimes(1);
    });
});
