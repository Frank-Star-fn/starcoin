const express = require('express');
const request = require('supertest');
const createTxRoutes = require('../../src/routes/api-tx');
const { createHdContext, deriveAddress, MAX_INDEX } = require('../../src/hd-wallet');
const { createMockStarCoin, createMockP2P, newFreshChain } = require('../helpers');
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function appFor(chain = createMockStarCoin()) {
    const app = express();
    app.use(express.json());
    app.use(createTxRoutes(chain, () => {}, createMockP2P()));
    return app;
}

describe('HD wallet API', () => {
    it('creates and restores the same HD root and child, with no-store responses', async () => {
        const app = appFor();
        const created = await request(app).post('/wallet/hd/new').send({ strength: 256, passphrase: 'secret' });
        expect(created.status).toBe(200);
        expect(created.headers['cache-control']).toBe('no-store');
        expect(created.body.mnemonic.split(' ')).toHaveLength(24);
        const restored = await request(app).post('/wallet/hd/import').send({ mnemonic: created.body.mnemonic, passphrase: 'secret' });
        expect(restored.body.root).toEqual(created.body.root);
        expect(restored.body.wallets).toEqual(created.body.wallets);
        expect(restored.body.scanNextIndex).toBe(20);
        expect(JSON.stringify(created.body.root)).not.toMatch(/mnemonic|privateKey|xprv|seed/);
    });

    it('derives batches and explicit backup indices deterministically', async () => {
        const app = appFor();
        const range = await request(app).post('/wallet/hd/derive').send({ mnemonic, startIndex: 3, count: 2 });
        const explicit = await request(app).post('/wallet/hd/derive').send({ mnemonic, indices: [4, 3, 4] });
        expect(range.status).toBe(200);
        expect(explicit.body.wallets).toEqual([range.body.wallets[1], range.body.wallets[0]]);
        expect(explicit.body.nextIndex).toBe(5);
    });

    it('recovers zero-balance addresses with confirmed history and pending transactions', async () => {
        const context = createHdContext(mnemonic);
        const child = deriveAddress(context, 3);
        const pending = deriveAddress(context, 5);
        const chain = createMockStarCoin({ chain: [{ transactions: [{ from: child.address, to: 'spent', amount: 10 }] }],
            pendingTransactions: [{ from: 'sender', to: pending.address, amount: 1 }], getBalance: () => 0 });
        const result = await request(appFor(chain)).post('/wallet/hd/import').send({ mnemonic });
        expect(result.body.wallets.map(w => w.index)).toEqual([0, 3, 5]);
        expect(result.body.nextIndex).toBe(6);
        expect(result.body.scanNextIndex).toBe(26);
    });

    it('signs and submits a real child-address transaction through the existing API', async () => {
        const chain = newFreshChain();
        const app = appFor(chain);
        const response = await request(app).post('/wallet/hd/derive').send({ mnemonic, count: 2 });
        const [sender, receiver] = response.body.wallets;
        chain.mineBlock(sender.address);
        const submitted = await request(app).post('/transaction').send({ from: sender.address, to: receiver.address,
            amount: 5, fee: 1, currency: 'STC', privateKey: sender.privateKey, publicKey: sender.publicKey });
        expect(submitted.status).toBe(200);
        expect(chain.pendingTransactions).toHaveLength(1);
        chain.mineBlock(sender.address);
        expect(chain.getBalance(receiver.address)).toBe(5);
    });

    it.each([
        ['/new', { strength: 129 }], ['/new', { strength: '128' }],
        ['/derive', { mnemonic, startIndex: -1 }], ['/derive', { mnemonic, count: 101 }],
        ['/derive', { mnemonic, indices: [] }], ['/derive', { mnemonic, indices: [MAX_INDEX + 1] }],
        ['/derive', { mnemonic, indices: ['0'] }], ['/derive', { mnemonic: 'invalid' }],
        ['/import', { mnemonic, scanCount: 201 }], ['/import', { mnemonic, startIndex: 0.1 }],
        ['/import', { mnemonic, passphrase: {} }], ['/import', { mnemonic, scheme: 'other' }],
        ['/import', { mnemonic, basePath: 'm/0' }]
    ])('rejects invalid request %s %j', async (path, body) => {
        const response = await request(appFor()).post('/wallet/hd' + path).send(body);
        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.code).toBe('INVALID_HD_WALLET');
        expect(JSON.stringify(response.body)).not.toContain(mnemonic);
    });
});
