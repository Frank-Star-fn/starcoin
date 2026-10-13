const express = require('express');
const request = require('supertest');
const { Wallet } = require('ethers');
const walletCrypto = require('../../src/front/wallet-crypto');
const { generateWallet } = require('../../src/core');
const { EvmBlockchain } = require('../../src/evm/blockchain');
const config = require('../../src/config');
const createTxRoutes = require('../../src/routes/api-tx');
const createEvmRoutes = require('../../src/routes/api-evm');
const { newFreshChain, createMockP2P } = require('../helpers');

describe('signed-only wallet API', () => {
    let originalLegacy, originalToken;
    beforeEach(() => { originalLegacy = config.LEGACY_WALLET_API; originalToken = config.ADMIN_TOKEN; config.LEGACY_WALLET_API = false; config.ADMIN_TOKEN = ''; });
    afterEach(() => { config.LEGACY_WALLET_API = originalLegacy; config.ADMIN_TOKEN = originalToken; });
    function appFor(chain) {
        const app = express(); app.use(express.json()); app.use('/api', createTxRoutes(chain, () => {}, createMockP2P()));
        app.use('/api', createEvmRoutes(chain, createMockP2P(), () => {})); return app;
    }
    it.each(['/wallet/new', '/wallet/import', '/wallet/import-mnemonic', '/wallet/hd/new', '/wallet/hd/import',
        '/wallet/hd/derive', '/transaction', '/evm/deposit', '/evm/withdraw', '/evm/transaction', '/evm/estimate',
        '/EVM/deposit/', '/EVM/estimate/'])('disables legacy secret path %s by default', async path => {
        await request(appFor(newFreshChain())).post('/api' + path).send({ privateKey: 'test-secret' }).expect(410);
    });
    it('accepts a browser-signed transfer, rejects tampering and replay, without any admin token', async () => {
        const chain = newFreshChain(), wallet = generateWallet(); chain.mineBlock(wallet.address); const app = appFor(chain);
        const context = (await request(app).get('/api/transaction/context/' + wallet.address).expect(200)).body;
        const transaction = walletCrypto.signNative(wallet.privateKey, { ...context, nonce: context.nextNonce, to: 'a'.repeat(32), amount: '1.00000001' });
        await request(app).post('/api/transaction/signed').send({ transaction: { ...transaction, amount: '2' } }).expect(400);
        await request(app).post('/api/transaction/signed').send({ transaction, privateKey: wallet.privateKey }).expect(400);
        await request(app).post('/api/transaction/signed').send({ transaction }).expect(200);
        await request(app).post('/api/transaction/signed').send({ transaction }).expect(400);
        expect((await request(app).get('/api/transaction/context/' + wallet.address)).body.nextNonce).toBe(1);
    });
    it.each([false, true])('executes browser-signed deposits, contract deployment and withdrawals, modern=%s', async modern => {
        const chain = new EvmBlockchain(45120, true, { consensus: { initialDifficulty: 1, difficultyMin: 0,
            coinbaseMaturity: 0, difficultyAdjustInterval: 1000000, activationHeight: 1 }, rpc: modern ? { activationHeight: 1 } : null });
        await chain.ready; const wallet = generateWallet(), signer = new Wallet(walletCrypto.rawFromPem(wallet.privateKey)), app = appFor(chain);
        await chain.mineBlock(wallet.address);
        const deposit = walletCrypto.signEnvelope(wallet.privateKey, { chainId: chain.consensus.params.chainId, nonce: 0, kind: 'deposit',
            to: 'EVM:' + signer.address.toLowerCase(), evmAddress: signer.address.toLowerCase(), amount: '10' });
        await request(app).post('/api/evm/signed').send({ transaction: deposit }).expect(200); await chain.mineBlock(wallet.address);
        const ctx = (await request(app).get('/api/evm/signing-context/' + signer.address).expect(200)).body;
        const artifact = require('../../public/contracts/Counter.json');
        const raw = await signer.signTransaction({ type: 0, chainId: ctx.evmChainId, nonce: Number(ctx.nonce), gasPrice: ctx.gasPriceWei,
            gasLimit: 1000000, data: artifact.bytecode + '0'.repeat(64), value: 0 });
        let response;
        if (modern) response = await request(app).post('/api/evm/raw').send({ rawTransaction: raw }).expect(200);
        else {
            const tx = walletCrypto.signEnvelope(wallet.privateKey, { chainId: ctx.chainId, nonce: 1, kind: 'evm', to: 'EVM_CREATE', evmAddress: signer.address.toLowerCase(), rawTransaction: raw });
            response = await request(app).post('/api/evm/signed').send({ transaction: tx }).expect(200);
        }
        await chain.mineBlock(wallet.address); expect(chain.receipt(response.body.transaction.id).status).toBe(1);
        expect(chain.receipt(response.body.transaction.id).contractAddress).toMatch(/^0x/);
        const from = signer.address;
        await request(app).post('/api/evm/estimate').send({ from, to: signer.address, valueWei: '1', gasLimit: '21000' }).expect(200);
        const withdrawal = walletCrypto.signEnvelope(wallet.privateKey, { chainId: ctx.chainId, nonce: chain.query.getAddressNonce(wallet.address, true),
            kind: 'withdraw', to: wallet.address, evmAddress: signer.address.toLowerCase(), amount: '1.00000001' });
        await request(app).post('/api/evm/signed').send({ transaction: withdrawal }).expect(200); await chain.mineBlock(wallet.address);
        expect(chain.receipt(withdrawal.id).status).toBe(1);
    }, 20000);
    it('requires explicit local compatibility and administration credentials for legacy APIs', async () => {
        const app = appFor(newFreshChain()); config.LEGACY_WALLET_API = true; config.ADMIN_TOKEN = 'local-admin';
        await request(app).post('/api/wallet/new').expect(401);
        await request(app).post('/api/wallet/new').set('Authorization', 'Bearer local-admin').set('X-Forwarded-For', '127.0.0.1').expect(403);
        const response = await request(app).post('/api/wallet/new').set('Authorization', 'Bearer local-admin').expect(200);
        expect(response.headers['cache-control']).toBe('no-store');
    });
});
