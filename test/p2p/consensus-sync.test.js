const http = require('http');
const WebSocket = require('ws');
const { createP2P } = require('../../src/p2p/p2p');
const { newFreshChain } = require('../helpers');
const { createChainSync } = require('../../src/p2p/chain-sync');

async function until(predicate) {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('等待真实 P2P 同步超时');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
function timedBranch(count, seconds) {
    const chain = newFreshChain({ difficultyAdjustInterval: 3, difficultyStep: 1, difficultyMax: 3 });
    const start = Date.now() - 100000;
    for (let i = 0; i < count; i++) {
        const { block } = chain.buildCandidate('miner'); block.timestamp = new Date(start + i * seconds * 1000).toISOString();
        const reward = block.transactions[0]; reward.timestamp = block.timestamp; reward.id = reward.calculateHash();
        block.updateMerkleRoot(); block.hash = block.calculateHash(); block.mineBlock(chain.difficulty);
        if (!chain.addBlock(block)) throw new Error('无效测试分支');
    }
    return chain;
}

it('真实 WebSocket 同步汇聚采用高工作量短链，忽略对方声称的工作量', async () => {
    const strong = timedBranch(4, 1), weak = timedBranch(6, 20);
    const chain = newFreshChain(strong.consensus.params);
    const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    // Disable only delayed auto-discovery during this isolated loopback test.
    const realTimeout = global.setTimeout;
    const spy = vi.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...args) => realTimeout(ms === 3000 ? () => {} : fn, ms === 3000 ? 1 : ms, ...args));
    let p2p;
    try { p2p = createP2P(server, chain, port); } finally { spy.mockRestore(); }
    const peers = [];
    try {
        for (const [i, branch] of [strong, weak].entries()) {
            const peer = new WebSocket('ws://127.0.0.1:' + port); peers.push(peer);
            const sync = createChainSync({ sendMessage: (ws, message) => ws.send(JSON.stringify({ ...message,
                chainWork: i === 1 ? '9999999999999999999' : '0' })) }, branch);
            peer.on('message', data => {
                const message = JSON.parse(data.toString());
                if (['SYNC_REQUEST', 'QUERY_BLOCKS'].includes(message.type)) sync.handle(peer, message);
            });
            await new Promise((resolve, reject) => { peer.once('open', resolve); peer.once('error', reject); });
        }
        expect(p2p.syncWithPeers().success).toBe(true);
        await until(() => !p2p.getSyncState().isSyncing);
        expect(chain.getLatestBlock().hash).toBe(strong.getLatestBlock().hash);
        expect(chain.chain.length).toBeLessThan(weak.chain.length);
        peers[1].send(JSON.stringify({ type: 'TRANSACTION', transaction: strong.chain[1].transactions[0] }));
        await new Promise(resolve => setTimeout(resolve, 20)); expect(chain.pendingTransactions).toHaveLength(0);
    } finally {
        peers.forEach(peer => peer.terminate()); p2p.wss.clients.forEach(peer => peer.terminate());
        p2p.stopHealthCheck(); p2p.stopDiscovery();
        await new Promise(resolve => p2p.wss.close(resolve)); await new Promise(resolve => server.close(resolve));
    }
});
