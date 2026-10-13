const config = require('../../src/config');
const express = require('express');
const legacyConfig = { token: config.ADMIN_TOKEN, legacy: config.LEGACY_WALLET_API };
beforeAll(() => { config.ADMIN_TOKEN = 'test-admin'; config.LEGACY_WALLET_API = true; });
afterAll(() => { config.ADMIN_TOKEN = legacyConfig.token; config.LEGACY_WALLET_API = legacyConfig.legacy; });

const request = require('supertest');
const { generateWallet } = require('../../src/core');
const createTxRoutes = require('../../src/routes/api-tx');
const createNetRoutes = require('../../src/routes/api-net');
const { createErrorMiddleware } = require('../../src/routes/error-handler');
const { newFreshChain, createMockP2P, createSignedTx } = require('../helpers');

describe('真实账本上的 HTTP 双花防护', () => {
    let chain, alice, app;
    const previousToken = config.ADMIN_TOKEN;
    beforeAll(() => { config.ADMIN_TOKEN = 'test-admin'; });
    afterAll(() => { config.ADMIN_TOKEN = previousToken; });
    beforeEach(() => {
        chain = newFreshChain(); alice = generateWallet(); chain.mineBlock(alice.address);
        chain.paymentConfirmations = 2;
        const p2p = createMockP2P(); app = express(); app.use(express.json()); app.use((req, _res, next) => { req.headers.authorization = 'Bearer test-admin'; next(); });
        app.use('/api', createTxRoutes(chain, () => {}, p2p));
        app.use('/api', createNetRoutes(chain, p2p, 9876));
        app.use(createErrorMiddleware());
    });
    function pay(values = {}) {
        return request(app).post('/api/transaction').send({ from: alice.address, to: 'b'.repeat(32), amount: 10,
            privateKey: alice.privateKey, publicKey: alice.publicKey, ...values });
    }
    it('HTTP 自动分配连续 nonce，并阻止累计透支', async () => {
        const first = await pay({ amount: 30 }); expect(first.status).toBe(200);
        expect(first.body.transaction.version).toBe(2); expect(first.body.transaction.nonce).toBe(0);
        const nonce = await request(app).get('/api/nonce/' + alice.address); expect(nonce.body.nextNonce).toBe(1);
        const rejected = await pay({ amount: 30 }); expect(rejected.status).toBe(400);
        expect(chain.pendingTransactions).toHaveLength(1);
    });
    it('显式重复 nonce 的不同收款请求被拒绝', async () => {
        expect((await pay({ nonce: 0 })).status).toBe(200);
        expect((await pay({ nonce: 0, to: 'c'.repeat(32) })).status).toBe(400);
    });
    it('状态端点显示 pending、included、confirmed', async () => {
        const response = await pay(), id = response.body.transaction.id;
        const status = () => request(app).get('/api/transaction/' + id + '/status');
        expect((await status()).body.status).toBe('pending'); chain.mineBlock('miner');
        expect((await status()).body.confirmations).toBe(1); chain.mineBlock('miner');
        expect((await status()).body.status).toBe('confirmed');
    });
    it('未知交易返回 unknown，畸形 ID 返回 400', async () => {
        expect((await request(app).get('/api/transaction/' + 'a'.repeat(64) + '/status')).body.status).toBe('unknown');
        expect((await request(app).get('/api/transaction/bad/status')).status).toBe(400);
    });
    it.each([true, '0.000000001', -1, 'Infinity'])('拒绝非法金额 %s', async amount => {
        expect((await pay({ amount })).status).toBe(400); expect(chain.pendingTransactions).toHaveLength(0);
    });
    it('导入弱链不能绕过累计工作量规则', async () => {
        const original = chain.getLatestBlock().hash;
        const weak = newFreshChain();
        expect((await request(app).post('/api/storage/import').set('Authorization', 'Bearer test-admin').send({ chain: weak.chain })).status).toBe(400);
        expect(chain.getLatestBlock().hash).toBe(original);
    });
    it('nonce 查询不受被篡改交易池的计数污染', async () => {
        const invalid = createSignedTx(alice, 'bob', 100); chain.pendingTransactions.push(invalid);
        expect((await request(app).get('/api/nonce/' + alice.address)).body.nextNonce).toBe(0);
        expect((await pay()).status).toBe(200); expect(chain.pendingTransactions).toHaveLength(1);
    });
});
