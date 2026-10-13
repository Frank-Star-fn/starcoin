const http = require('http');
const { Interface, Wallet } = require('ethers');
const { createP2P } = require('../../src/p2p/p2p');
const { EvmBlockchain } = require('../../src/evm/blockchain');
const { generateWallet } = require('../../src/core');
const artifact = require('../../public/contracts/Counter.json');
async function eventually(check) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('P2P 同步超时');
}
async function node(rpc = null) {
    const chain = new EvmBlockchain(45040, true, { consensus: { initialDifficulty: 1, difficultyMin: 0,
        coinbaseMaturity: 0, difficultyAdjustInterval: 1000000, activationHeight: 1 }, rpc }); await chain.ready;
    const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port, p2p = createP2P(server, chain, port);
    return { chain, server, p2p, port };
}
describe('EVM over real P2P sockets', () => {
    it('replicates externally signed MetaMask transactions and receipts across nodes', async () => {
        const nodes = await Promise.all([node({ activationHeight: 1 }), node({ activationHeight: 1 })]);
        try {
            const [first, second] = nodes, wallet = generateWallet(), external = Wallet.createRandom();
            second.p2p.connectToPeer('ws://127.0.0.1:' + first.port);
            await eventually(() => first.p2p.getConnectedCount() > 0);
            const mine = async () => { await first.chain.mineBlock(wallet.address); first.p2p.broadcastLatest();
                await eventually(() => second.chain.getLatestBlock().hash === first.chain.getLatestBlock().hash); };
            await mine(); await first.chain.submitEvm(wallet.privateKey, { kind: 'deposit', amount: '1', evmAddress: external.address }); await mine();
            const signed = await external.signTransaction({ type: 2, chainId: 155001, nonce: 0, to: external.address, gasLimit: 21000,
                maxFeePerGas: 30000000000n, maxPriorityFeePerGas: 1000000000n });
            const tx = await first.chain.submitRaw(signed); first.p2p.broadcastTransaction(tx);
            await eventually(() => second.chain.hasPendingTransaction(tx.id)); await mine();
            expect(second.chain.receipt(tx.id).transactionHash).toBe(first.chain.receipt(tx.id).transactionHash);
            expect(second.chain._evaluation.evmStateRoot).toBe(first.chain._evaluation.evmStateRoot);
        } finally { for (const n of nodes) { n.p2p.stopDiscovery(); n.p2p.stopHealthCheck(); for (const client of n.p2p.wss.clients) client.terminate(); n.p2p.wss.close(); n.server.close(); } }
    }, 20000);
    it('replicates deposits, contract transactions and replayed roots across three nodes', async () => {
        const nodes = await Promise.all([node(), node(), node()]);
        try {
            const [first, second, third] = nodes, wallet = generateWallet(), iface = new Interface(artifact.abi);
            second.p2p.connectToPeer('ws://127.0.0.1:' + first.port);
            third.p2p.connectToPeer('ws://127.0.0.1:' + first.port);
            await eventually(() => first.p2p.getConnectedCount() >= 2);
            const mine = async () => {
                await first.chain.mineBlock(wallet.address); first.p2p.broadcastLatest();
                await eventually(() => nodes.every(n => n.chain.getLatestBlock().hash === first.chain.getLatestBlock().hash));
                expect(nodes.every(n => n.chain._evaluation.evmStateRoot === first.chain._evaluation.evmStateRoot)).toBe(true);
            };
            await mine();
            const deposit = await first.chain.submitEvm(wallet.privateKey, { kind: 'deposit', amount: '10' });
            first.p2p.broadcastTransaction(deposit);
            await eventually(() => nodes.every(n => n.chain.hasPendingTransaction(deposit.id))); await mine();
            const deploy = await first.chain.submitEvm(wallet.privateKey, { data: artifact.bytecode });
            first.p2p.broadcastTransaction(deploy); await mine();
            const target = first.chain.receipt(deploy.id).contractAddress;
            const write = await first.chain.submitEvm(wallet.privateKey, { to: target, data: iface.encodeFunctionData('set', [77]) });
            first.p2p.broadcastTransaction(write); await mine();
            for (const n of nodes) {
                expect(BigInt(await n.chain._evaluation.engine.storage(target, '0'))).toBe(77n);
                expect(n.chain.receipt(write.id).logs).toHaveLength(1);
            }
            // A fresh peer adopts the complete chain through asynchronous candidate scoring.
            const fourth = await node(); nodes.push(fourth);
            const adopt = fourth.chain.replaceChain.bind(fourth.chain);
            let acceptChains = false;
            fourth.chain.replaceChain = chain => acceptChains ? adopt(chain) : Promise.resolve(false);
            fourth.p2p.connectToPeer('ws://127.0.0.1:' + first.port);
            await eventually(() => fourth.p2p.getConnectedCount() > 0);
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(fourth.chain.chain.length).toBe(1);
            acceptChains = true;
            fourth.p2p.syncWithPeers();
            await eventually(() => fourth.chain.chain.length === first.chain.chain.length && fourth.p2p.getSyncState().lastSyncAt !== null);
            expect(fourth.chain._evaluation.evmStateRoot).toBe(first.chain._evaluation.evmStateRoot);
        } finally {
            for (const n of nodes) { n.p2p.stopDiscovery(); n.p2p.stopHealthCheck(); for (const client of n.p2p.wss.clients) client.terminate(); n.p2p.wss.close(); n.server.close(); }
        }
    }, 20000);
});
