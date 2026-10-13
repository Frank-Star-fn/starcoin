const express = require('express');
const request = require('supertest');
const { Interface } = require('ethers');
const createEvmRoutes = require('../../src/routes/api-evm');
const { EvmBlockchain } = require('../../src/evm/blockchain');
const { generateWallet } = require('../../src/core');
const { evmAddressFromPem } = require('../../src/evm/engine');
const counter = require('../../public/contracts/Counter.json');
const token = require('../../public/contracts/DemoToken.json');

async function setup() {
    const chain = new EvmBlockchain(45021, true, { consensus: { initialDifficulty: 1, difficultyMin: 0,
        coinbaseMaturity: 0, difficultyAdjustInterval: 1000000, activationHeight: 1 } });
    await chain.ready;
    const wallet = generateWallet(), p2p = { broadcastTransaction: vi.fn() }, push = vi.fn();
    const app = express(); app.use(express.json()); app.use('/api', createEvmRoutes(chain, p2p, push));
    await chain.mineBlock(wallet.address);
    await request(app).post('/api/evm/deposit').send({ privateKey: wallet.privateKey, amount: '10' }).expect(200);
    await chain.mineBlock(wallet.address);
    return { chain, wallet, app, p2p, push };
}
async function deploy(context, artifact) {
    const iface = new Interface(artifact.abi);
    const response = await request(context.app).post('/api/evm/transaction').send({ privateKey: context.wallet.privateKey,
        data: artifact.bytecode + iface.encodeDeploy(artifact.constructorArgs).slice(2) }).expect(200);
    await context.chain.mineBlock(context.wallet.address);
    return { iface, address: context.chain.receipt(response.body.transaction.id).contractAddress };
}

describe('EVM REST API', () => {
    it('derives the standard address and exposes committed balance, code and network settings', async () => {
        const ctx = await setup(), source = evmAddressFromPem(ctx.wallet.privateKey);
        const derived = await request(ctx.app).post('/api/evm/address').send({ publicKey: ctx.wallet.publicKey }).expect(200);
        expect(derived.body.address).toBe(source);
        const account = await request(ctx.app).get('/api/evm/account/' + source).expect(200);
        expect(account.body.balanceWei).toBe('10000000000000000000');
        const status = await request(ctx.app).get('/api/evm/status').expect(200);
        expect(status.body.hardfork).toBe('shanghai');
        expect(ctx.p2p.broadcastTransaction).toHaveBeenCalledTimes(1);
    });
    it('estimates, deploys and calls Counter without mutating committed state during simulation', async () => {
        const ctx = await setup(), deployed = await deploy(ctx, counter);
        const data = deployed.iface.encodeFunctionData('set', [42]);
        const root = ctx.chain._evaluation.evmStateRoot, pool = JSON.stringify(ctx.chain.pendingTransactions);
        const estimate = await request(ctx.app).post('/api/evm/estimate').send({ privateKey: ctx.wallet.privateKey, to: deployed.address, data }).expect(200);
        await request(ctx.app).post('/api/evm/call').send({ to: deployed.address, data }).expect(200);
        expect(ctx.chain._evaluation.evmStateRoot).toBe(root);
        expect(JSON.stringify(ctx.chain.pendingTransactions)).toBe(pool);
        const tx = await request(ctx.app).post('/api/evm/transaction').send({ privateKey: ctx.wallet.privateKey,
            to: deployed.address, data, gasLimit: estimate.body.gasLimit }).expect(200);
        const pending = await request(ctx.app).get('/api/evm/receipt/' + tx.body.transaction.id).expect(200);
        expect(pending.body.receipt.status).toBe('pending');
        await ctx.chain.mineBlock(ctx.wallet.address);
        const read = await request(ctx.app).post('/api/evm/call').send({ to: deployed.address, data: deployed.iface.encodeFunctionData('count') }).expect(200);
        expect(deployed.iface.decodeFunctionResult('count', read.body.returnData)[0]).toBe(42n);
        const logs = await request(ctx.app).get('/api/evm/logs').query({ address: deployed.address }).expect(200);
        expect(logs.body.logs).toHaveLength(1);
        expect(deployed.iface.parseLog(logs.body.logs[0]).args.value).toBe(42n);
        const storage = await request(ctx.app).get('/api/evm/storage/' + deployed.address + '/0').expect(200);
        expect(BigInt(storage.body.value)).toBe(42n);
    });
    it('confirms REVERT and out-of-gas receipts without treating them as invalid blocks', async () => {
        const ctx = await setup(), deployed = await deploy(ctx, counter);
        for (const options of [{ data: deployed.iface.encodeFunctionData('fail') },
            { data: deployed.iface.encodeFunctionData('set', [10]), gasLimit: '22000' }]) {
            const tx = await request(ctx.app).post('/api/evm/transaction').send({ privateKey: ctx.wallet.privateKey, to: deployed.address, ...options }).expect(200);
            await ctx.chain.mineBlock(ctx.wallet.address);
            const receipt = await request(ctx.app).get('/api/evm/receipt/' + tx.body.transaction.id).expect(200);
            expect(receipt.body.receipt.status).toBe(0);
            expect(BigInt(receipt.body.receipt.feeWei)).toBeGreaterThan(0n);
        }
        expect(await ctx.chain.isChainValid()).toBe(true);
    });
    it('executes ERC20 transfers, approvals and transferFrom with exact uint256 values', async () => {
        const ctx = await setup(), deployed = await deploy(ctx, token), second = generateWallet();
        const firstAddress = evmAddressFromPem(ctx.wallet.privateKey), secondAddress = evmAddressFromPem(second.privateKey);
        const send = async (pem, method, args) => {
            await request(ctx.app).post('/api/evm/transaction').send({ privateKey: pem, to: deployed.address,
                data: deployed.iface.encodeFunctionData(method, args) }).expect(200);
            await ctx.chain.mineBlock(ctx.wallet.address);
        };
        await send(ctx.wallet.privateKey, 'transfer', [secondAddress, '1234567890123456789']);
        await send(ctx.wallet.privateKey, 'approve', [secondAddress, '100']);
        await request(ctx.app).post('/api/evm/deposit').send({ privateKey: ctx.wallet.privateKey, evmAddress: secondAddress, amount: '1' }).expect(200);
        await ctx.chain.mineBlock(ctx.wallet.address);
        await send(second.privateKey, 'transferFrom', [firstAddress, secondAddress, '100']);
        const read = await request(ctx.app).post('/api/evm/call').send({ to: deployed.address,
            data: deployed.iface.encodeFunctionData('balanceOf', [secondAddress]) }).expect(200);
        expect(deployed.iface.decodeFunctionResult('balanceOf', read.body.returnData)[0]).toBe(1234567890123456889n);
        const replay = await ctx.chain.consensus.evaluateAsync(JSON.parse(JSON.stringify(ctx.chain.chain)));
        expect(replay.valid).toBe(true); expect(replay.evmStateRoot).toBe(ctx.chain._evaluation.evmStateRoot);
    });
    it('rejects malformed addresses, precision loss, missing keys and excessive query ranges', async () => {
        const ctx = await setup();
        await request(ctx.app).get('/api/evm/account/abc').expect(400);
        await request(ctx.app).post('/api/evm/deposit').send({ privateKey: ctx.wallet.privateKey, amount: '0.000000001' }).expect(400);
        await request(ctx.app).post('/api/evm/transaction').send({ valueWei: 9007199254740992 }).expect(400);
        await request(ctx.app).get('/api/evm/logs').query({ fromBlock: 0, toBlock: 3000 }).expect(400);
        await request(ctx.app).post('/api/evm/estimate').send({}).expect(400);
    });
});
