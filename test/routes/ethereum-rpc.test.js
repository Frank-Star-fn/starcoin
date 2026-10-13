const express = require('express');
const request = require('supertest');
const http = require('http');
const { Wallet, Interface, JsonRpcProvider, ContractFactory, Contract, keccak256 } = require('ethers');
const { EvmBlockchain } = require('../../src/evm/blockchain');
const { generateWallet } = require('../../src/core');
const createRpc = require('../../src/rpc');
const config = require('../../src/config');
const artifact = require('../../public/contracts/Counter.json');
async function setup() {
    const chain = new EvmBlockchain(45090, true, { consensus: { activationHeight: 1, legacyCheckpointHash: '', initialDifficulty: 1,
        difficultyMin: 0, coinbaseMaturity: 0, difficultyAdjustInterval: 1000000 }, rpc: { activationHeight: 1 } }); await chain.ready;
    const wallet = Wallet.createRandom(), native = generateWallet(), p2p = { broadcastTransaction: vi.fn() };
    await chain.mineBlock(native.address); await chain.submitEvm(native.privateKey, { kind: 'deposit', amount: '10', evmAddress: wallet.address }); await chain.mineBlock(native.address);
    const app = express(); app.use('/rpc', createRpc(chain, p2p, () => {}));
    const rpc = async (method, params = []) => (await request(app).post('/rpc').send({ jsonrpc: '2.0', id: 1, method, params }).expect(200)).body;
    const sign = options => wallet.signTransaction({ type: 2, chainId: 155001, nonce: 0, gasLimit: 1000000,
        maxFeePerGas: 30000000000n, maxPriorityFeePerGas: 1000000000n, ...options });
    return { app, chain, wallet, native, rpc, sign, p2p };
}
describe('Ethereum JSON-RPC', () => {
    it('handles network/account queries with Ethereum hex quantities and CORS', async () => {
        const ctx = await setup();
        expect((await ctx.rpc('eth_chainId')).result).toBe('0x25d79');
        expect((await ctx.rpc('net_version')).result).toBe('155001');
        expect(BigInt((await ctx.rpc('eth_getBalance', [ctx.wallet.address, 'latest'])).result)).toBe(10000000000000000000n);
        expect((await ctx.rpc('eth_getBalance', [ctx.wallet.address, 'earliest'])).result).toBe('0x0');
        expect((await ctx.rpc('eth_getTransactionCount', [ctx.wallet.address])).result).toBe('0x0');
        expect((await ctx.rpc('eth_getCode', [ctx.wallet.address])).result).toBe('0x');
        await request(ctx.app).options('/rpc').expect('Access-Control-Allow-Origin', '*').expect(204);
    });
    it('validates requests, batches, notifications, malformed JSON and method parameters', async () => {
        const ctx = await setup();
        expect((await ctx.rpc('missing')).error.code).toBe(-32601);
        expect((await ctx.rpc('eth_getBalance', ['wrong'])).error).toBeDefined();
        expect((await ctx.rpc('eth_getBalance', [ctx.wallet.address, '0x00'])).error.code).toBe(-32602);
        const batch = await request(ctx.app).post('/rpc').send([{ jsonrpc: '2.0', id: 'a', method: 'eth_chainId' }, { jsonrpc: '2.0', method: 'eth_blockNumber' }]).expect(200);
        expect(batch.body).toHaveLength(1); expect(batch.body[0].id).toBe('a');
        await request(ctx.app).post('/rpc').send({ jsonrpc: '2.0', method: 'eth_chainId' }).expect(204);
        expect((await request(ctx.app).post('/rpc').send([])).body.error.code).toBe(-32600);
        const malformed = await request(ctx.app).post('/rpc').set('Content-Type', 'application/json').send('{').expect(400);
        expect(malformed.body.error.code).toBe(-32700);
    });
    it('returns pending nonce, signed hash, standard receipts and historical state', async () => {
        const ctx = await setup(), to = Wallet.createRandom().address, signed = await ctx.sign({ to, value: 100n });
        const response = await ctx.rpc('eth_sendRawTransaction', [signed]), hash = keccak256(signed);
        expect(response.result).toBe(hash); expect(ctx.p2p.broadcastTransaction).toHaveBeenCalledTimes(1);
        expect((await ctx.rpc('eth_getTransactionCount', [ctx.wallet.address, 'pending'])).result).toBe('0x1');
        expect((await ctx.rpc('eth_getTransactionCount', [ctx.wallet.address, 'latest'])).result).toBe('0x0');
        expect((await ctx.rpc('eth_getTransactionReceipt', [hash])).result).toBeNull();
        expect((await ctx.rpc('eth_getTransactionByHash', [hash])).result.blockHash).toBeNull();
        await ctx.chain.mineBlock(ctx.native.address);
        const receipt = (await ctx.rpc('eth_getTransactionReceipt', [hash])).result;
        expect(receipt.status).toBe('0x1'); expect(receipt.type).toBe('0x2'); expect(receipt.gasUsed).toBe('0x5208');
        expect((await ctx.rpc('eth_getBalance', [to, '0x2'])).result).toBe('0x0');
        expect((await ctx.rpc('eth_getBalance', [to, { blockHash: receipt.blockHash, requireCanonical: true }])).result).toBe('0x64');
        const block = (await ctx.rpc('eth_getBlockByHash', [receipt.blockHash, true])).result;
        expect(block.transactions[0].hash).toBe(hash); expect(block.transactions[0].transactionIndex).toBe('0x0');
        expect((await ctx.rpc('eth_getTransactionByBlockNumberAndIndex', [receipt.blockNumber, '0x0'])).result.hash).toBe(hash);
    });
    it('estimates without credentials, deploys Counter, exposes logs and ABI revert data', async () => {
        const ctx = await setup(), iface = new Interface(artifact.abi), root = ctx.chain._evaluation.evmStateRoot;
        const estimate = await ctx.rpc('eth_estimateGas', [{ from: ctx.wallet.address, data: artifact.bytecode }]);
        expect(estimate.error).toBeUndefined(); expect(ctx.chain._evaluation.evmStateRoot).toBe(root);
        const hash = (await ctx.rpc('eth_sendRawTransaction', [await ctx.sign({ data: artifact.bytecode, gasLimit: BigInt(estimate.result) })])).result;
        await ctx.chain.mineBlock(ctx.native.address); const to = (await ctx.rpc('eth_getTransactionReceipt', [hash])).result.contractAddress;
        const data = iface.encodeFunctionData('set', [42]);
        const tx = (await ctx.rpc('eth_sendRawTransaction', [await ctx.sign({ nonce: 1, to, data })])).result;
        await ctx.chain.mineBlock(ctx.native.address);
        const queried = await ctx.rpc('eth_call', [{ to, data: iface.encodeFunctionData('count') }, 'latest']);
        expect(iface.decodeFunctionResult('count', queried.result)[0]).toBe(42n);
        const logs = (await ctx.rpc('eth_getLogs', [{ address: to, fromBlock: '0x0', topics: [iface.getEvent('ValueChanged').topicHash] }])).result;
        expect(logs).toHaveLength(1); expect(logs[0].transactionHash).toBe(tx); expect(logs[0].removed).toBe(false);
        const revert = await ctx.rpc('eth_call', [{ to, data: iface.encodeFunctionData('fail') }]);
        expect(revert.error.code).toBe(3); expect(revert.error.data).toMatch(/^0x08c379a0/);
        expect(BigInt((await ctx.rpc('eth_getStorageAt', [to, '0x0'])).result)).toBe(42n);
    });
    it('reports coherent fee history and pending baseFee for wallet estimates', async () => {
        const ctx = await setup(), history = (await ctx.rpc('eth_feeHistory', ['0x3', 'latest', [10, 50, 90]])).result;
        expect(history.baseFeePerGas).toHaveLength(4); expect(history.reward).toHaveLength(3);
        const gasPrice = BigInt((await ctx.rpc('eth_gasPrice')).result), tip = BigInt((await ctx.rpc('eth_maxPriorityFeePerGas')).result);
        expect(gasPrice - tip).toBe(BigInt(history.baseFeePerGas.at(-1)));
        expect((await ctx.rpc('eth_feeHistory', ['0x3', 'latest', [90, 10]])).error.code).toBe(-32602);
    });
    it('includes intrinsic and access-list gas in eth_call without changing state', async () => {
        const ctx = await setup(), to = Wallet.createRandom().address;
        expect((await ctx.rpc('eth_call', [{ to, gas: '0x5208' }])).result).toBe('0x');
        expect((await ctx.rpc('eth_call', [{ to, gas: '0x5207' }])).error.code).toBe(3);
        const accessList = [{ address: to, storageKeys: [] }];
        expect((await ctx.rpc('eth_call', [{ to, accessList, gas: '0x5b68' }])).result).toBe('0x');
        expect((await ctx.rpc('eth_call', [{ to, accessList, gas: '0x5b67' }])).error.code).toBe(3);
        const hash = (await ctx.rpc('eth_sendRawTransaction', [await ctx.sign({ data: '0x6009600c60003960096000f35a60005260206000f3' })])).result;
        await ctx.chain.mineBlock(ctx.native.address);
        const contract = (await ctx.rpc('eth_getTransactionReceipt', [hash])).result.contractAddress, root = ctx.chain._evaluation.evmStateRoot;
        const result = await ctx.rpc('eth_call', [{ to: contract, gas: '0xc350' }]);
        expect(BigInt(result.result)).toBe(28998n); expect(ctx.chain._evaluation.evmStateRoot).toBe(root);
    });
    it('returns failed type-2 receipts while burning gas and preserving value and storage', async () => {
        const ctx = await setup(), before = await ctx.chain._evaluation.engine.balance(ctx.wallet.address);
        let spent = 0n;
        for (const [nonce, data, gasLimit] of [[0, '0x60006000fd', 100000], [1, '0x5b600056', 60000]]) {
            const hash = (await ctx.rpc('eth_sendRawTransaction', [await ctx.sign({ nonce, data, gasLimit, value: 100n })])).result;
            await ctx.chain.mineBlock(ctx.native.address);
            const receipt = (await ctx.rpc('eth_getTransactionReceipt', [hash])).result;
            expect(receipt.status).toBe('0x0'); expect(receipt.type).toBe('0x2'); expect(receipt.contractAddress).toBeNull();
            expect(receipt.logs).toEqual([]); if (nonce === 1) expect(BigInt(receipt.gasUsed)).toBe(BigInt(gasLimit));
            spent += BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
        }
        expect((await ctx.rpc('eth_getTransactionCount', [ctx.wallet.address])).result).toBe('0x2');
        expect(await ctx.chain._evaluation.engine.balance(ctx.wallet.address)).toBe(before - spent);
        expect(await ctx.chain._evaluation.engine.balance('0x000000000000000000000000000000000000dead')).toBe(0n);
    });
    it('removes orphaned receipts and logs and rebuilds pending state after a reorg', async () => {
        const ctx = await setup(), iface = new Interface(artifact.abi);
        const deployHash = (await ctx.rpc('eth_sendRawTransaction', [await ctx.sign({ data: artifact.bytecode })])).result;
        await ctx.chain.mineBlock(ctx.native.address);
        const to = (await ctx.rpc('eth_getTransactionReceipt', [deployHash])).result.contractAddress;
        const other = new EvmBlockchain(45091, true, { consensus: ctx.chain.consensus.params, evm: ctx.chain.consensus.evm, rpc: ctx.chain.consensus.rpc });
        await other.ready; await other.replaceChain(ctx.chain.chain);
        const hash = (await ctx.rpc('eth_sendRawTransaction', [await ctx.sign({ nonce: 1, to, data: iface.encodeFunctionData('set', [42]) })])).result;
        await ctx.chain.mineBlock(ctx.native.address);
        const orphan = (await ctx.rpc('eth_getTransactionReceipt', [hash])).result;
        expect((await ctx.rpc('eth_getLogs', [{ address: to, fromBlock: '0x0' }])).result).toHaveLength(1);
        await other.mineBlock(ctx.native.address); await other.mineBlock(ctx.native.address);
        expect(await ctx.chain.replaceChain(other.chain)).toBe(true);
        expect((await ctx.rpc('eth_getTransactionReceipt', [hash])).result).toBeNull();
        expect((await ctx.rpc('eth_getLogs', [{ address: to, fromBlock: '0x0' }])).result).toEqual([]);
        expect((await ctx.rpc('eth_getBalance', [ctx.wallet.address, { blockHash: orphan.blockHash }])).error).toBeDefined();
        expect((await ctx.rpc('eth_getStorageAt', [to, '0x0', 'latest'])).result).toBe('0x' + '0'.repeat(64));
        expect(BigInt((await ctx.rpc('eth_getStorageAt', [to, '0x0', 'pending'])).result)).toBe(42n);
        expect((await ctx.rpc('eth_getTransactionCount', [ctx.wallet.address, 'latest'])).result).toBe('0x1');
        expect((await ctx.rpc('eth_getTransactionCount', [ctx.wallet.address, 'pending'])).result).toBe('0x2');
    });
    it('verifies and confirms a MetaMask EIP-712 withdrawal through RPC', async () => {
        const ctx = await setup();
        const typed = (await ctx.rpc('starcoin_getWithdrawalTypedData', [{ owner: ctx.wallet.address, nativeAddress: ctx.native.address, amount: '1.00000001' }])).result;
        const { EIP712Domain, ...types } = typed.types;
        const signature = await ctx.wallet.signTypedData(typed.domain, types, typed.message);
        const id = (await ctx.rpc('starcoin_submitWithdrawal', [{ message: typed.message, signature }])).result;
        expect(id).toMatch(/^0x[0-9a-f]{64}$/); await ctx.chain.mineBlock(ctx.native.address);
        expect((await ctx.rpc('starcoin_getWithdrawalReceipt', [id])).result.status).toBe(1);
        expect((await ctx.rpc('starcoin_getBridgeNonce', [ctx.wallet.address])).result).toBe('0x1');
        expect((await ctx.rpc('eth_getTransactionCount', [ctx.wallet.address])).result).toBe('0x0');
    });
    it('works with ethers JsonRpcProvider, automatic fee population and ContractFactory', async () => {
        const ctx = await setup(), server = http.createServer(ctx.app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const provider = new JsonRpcProvider('http://127.0.0.1:' + server.address().port + '/rpc', undefined, { cacheTimeout: -1 });
        try {
            const signer = ctx.wallet.connect(provider), factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
            const deployed = await factory.deploy(); await ctx.chain.mineBlock(ctx.native.address);
            const receipt = await provider.getTransactionReceipt(deployed.deploymentTransaction().hash); expect(receipt.status).toBe(1);
            const contract = new Contract(receipt.contractAddress, artifact.abi, signer);
            const tx = await contract.set(88); await ctx.chain.mineBlock(ctx.native.address);
            expect((await provider.getTransactionReceipt(tx.hash)).status).toBe(1);
            expect(await contract.count()).toBe(88n);
        } finally { provider.destroy(); await new Promise(resolve => server.close(resolve)); }
    });
    it('charges batch operations individually against the rate limit', async () => {
        const ctx = await setup(), previous = config.RATE_LIMIT_GLOBAL_MAX; config.RATE_LIMIT_GLOBAL_MAX = 1;
        try {
            const result = await request(ctx.app).post('/rpc').send([1, 2].map(id => ({ jsonrpc: '2.0', id, method: 'eth_chainId' })));
            expect(result.body[0].result).toBe('0x25d79'); expect(result.body[1].error.code).toBe(-32005);
        } finally { config.RATE_LIMIT_GLOBAL_MAX = previous; }
    });
});
