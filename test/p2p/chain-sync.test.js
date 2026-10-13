const http = require('http');
const { EventEmitter } = require('events');
const config = require('../../src/config');
const { createP2P, MESSAGE_TYPES } = require('../../src/p2p/p2p');
const { createChainSync } = require('../../src/p2p/chain-sync');
const { validateMessage } = require('../../src/p2p/message-security');
const { newFreshChain, createSignedTx } = require('../helpers');
const { Block, Transaction, generateWallet } = require('../../src/core');

async function until(check) {
    const end = Date.now() + 15000;
    while (!check()) {
        if (Date.now() >= end) throw new Error('分批同步超时');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

// Build a fixture in linear time, then validate it through the real consensus evaluator.
function append(chain, count, note = '测'.repeat(1400), miner = 'miner') {
    const template = chain.buildCandidate(miner, note).block;
    for (let i = 0; i < count; i++) {
        const height = chain.chain.length, previous = chain.getLatestBlock();
        const timestamp = new Date((height === 1 ? Date.now() - 100000000 : Date.parse(previous.timestamp)) + 1000).toISOString();
        const transactions = template.transactions.map(data => {
            const tx = Transaction.fromJSON(data);
            tx.blockHeight = height; tx.timestamp = timestamp; tx.id = tx.calculateHash();
            return tx;
        });
        const block = new Block(height, timestamp, transactions, previous.hash, template);
        block.mineBlock(0); chain.chain.push(block);
    }
    expect(chain.isChainValid()).toBe(true);
}

async function node(chain) {
    const server = http.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    // Keep isolated tests from discovering other services on the user's machine.
    const timeout = global.setTimeout;
    const spy = vi.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...args) =>
        timeout(ms === 3000 ? () => {} : fn, ms === 3000 ? 1 : ms, ...args));
    let p2p;
    try { p2p = createP2P(server, chain, server.address().port); } finally { spy.mockRestore(); }
    const frames = [], requests = [];
    p2p.wss.prependListener('connection', ws => {
        const send = ws.send.bind(ws);
        ws.send = (data, ...args) => {
            frames.push({ type: JSON.parse(data).type, size: Buffer.byteLength(data) });
            return send(data, ...args);
        };
        ws.on('message', data => { const msg = JSON.parse(data); if (msg.type === 'QUERY_BLOCKS') requests.push(msg); });
    });
    return { server, p2p, chain, frames, requests, url: `ws://127.0.0.1:${server.address().port}` };
}

async function close(nodes) {
    for (const n of nodes) {
        n.p2p.stopHealthCheck(); n.p2p.stopDiscovery();
        for (const ws of n.p2p.wss.clients) ws.terminate();
    }
    for (const n of nodes) {
        await new Promise(resolve => n.p2p.wss.close(resolve));
        await new Promise(resolve => n.server.close(resolve));
    }
}

describe('bounded chain downloads over real WebSocket', () => {
    it('syncs a valid 921-block chain larger than 4 MiB, then reconnects and downloads only missing blocks', async () => {
        const source = newFreshChain({ initialDifficulty: 0 }); append(source, 920);
        expect(Buffer.byteLength(JSON.stringify({ type: 'CHAIN', chain: source.chain }))).toBeGreaterThan(4 * 1024 * 1024);
        const nodes = await Promise.all([node(source), node(newFreshChain(source.consensus.params))]);
        const [first, second] = nodes;
        try {
            second.p2p.connectToPeer(first.url, false);
            await until(() => second.chain.getLatestBlock().hash === source.getLatestBlock().hash);
            expect(first.requests.length).toBeGreaterThan(1);
            expect(first.requests[0].start).toBe(1);
            expect(first.frames.every(frame => frame.size <= config.P2P_MAX_PAYLOAD)).toBe(true);
            expect(first.frames.some(frame => frame.type === 'CHAIN')).toBe(false);

            second.p2p.disconnectFromPeer(first.url);
            await until(() => first.p2p.wss.clients.size === 0);
            append(source, 12); first.requests.length = 0;
            second.p2p.connectToPeer(first.url, false);
            await until(() => second.chain.getLatestBlock().hash === source.getLatestBlock().hash);
            expect(first.requests[0].start).toBe(921);
            expect(second.chain.isChainValid()).toBe(true);

            const result = second.p2p.syncWithPeers();
            expect(result.requestedNodes).toBe(1);
            await until(() => !second.p2p.getSyncState().isSyncing);
            expect(second.p2p.getSyncState().candidateCount).toBe(1);
        } finally { await close(nodes); }
    }, 30000);

    it('fragments a valid single block larger than 4 MiB without mutating the chain before download completes', async () => {
        const source = newFreshChain({ initialDifficulty: 0, maxTransactions: 500 }), wallet = generateWallet();
        source.mineBlock(wallet.address);
        for (let i = 0; i < 400; i++) source.pendingTransactions.push(createSignedTx(wallet, 'recipient', 0.01, 0, '测'.repeat(4096), 'STC', i));
        source.mineBlock('miner');
        expect(Buffer.byteLength(JSON.stringify(source.getLatestBlock()))).toBeGreaterThan(config.P2P_MAX_PAYLOAD);
        const nodes = await Promise.all([node(source), node(newFreshChain(source.consensus.params))]);
        const [first, second] = nodes;
        try {
            second.p2p.connectToPeer(first.url, false);
            await until(() => first.requests.some(request => request.offset > 0));
            expect(second.chain.chain.length).toBe(1);
            await until(() => second.chain.getLatestBlock().hash === source.getLatestBlock().hash);
            expect(first.requests.filter(request => request.offset > 0).length).toBeGreaterThan(1);
            expect(first.frames.every(frame => frame.size <= config.P2P_MAX_PAYLOAD)).toBe(true);
            expect(second.chain.isChainValid()).toBe(true);
        } finally { await close(nodes); }
    }, 30000);

    it('restarts if the pinned branch changes midway, and adopts only the complete replacement branch', async () => {
        const source = newFreshChain({ initialDifficulty: 0 }); append(source, 400);
        const replacement = newFreshChain(source.consensus.params); append(replacement, 401, '另一个分支');
        const nodes = await Promise.all([node(source), node(newFreshChain(source.consensus.params))]);
        const [first, second] = nodes;
        first.p2p.wss.on('connection', ws => {
            const send = ws.send.bind(ws); let changed = false;
            ws.send = (data, ...args) => {
                const result = send(data, ...args);
                if (!changed && JSON.parse(data).type === 'BLOCKS') { changed = true; source.chain = replacement.chain; }
                return result;
            };
        });
        try {
            second.p2p.connectToPeer(first.url, false);
            await until(() => second.chain.getLatestBlock().hash === replacement.getLatestBlock().hash);
            expect(first.frames.some(frame => frame.type === 'SYNC_RESTART')).toBe(true);
            expect(second.chain.isChainValid()).toBe(true);
        } finally { await close(nodes); }
    }, 30000);
});

describe('chain download boundaries', () => {
    function fixture() {
        const chain = newFreshChain({ initialDifficulty: 0 });
        const ws = new EventEmitter(), sent = [], onChain = vi.fn(), onFailure = vi.fn();
        const sync = createChainSync({ sendMessage: (_, message) => sent.push(message) }, chain, { onChain, onFailure });
        sync.request(ws, 'test');
        return { chain, ws, sync, sent, onChain, onFailure };
    }
    const summary = { type: 'CHAIN_SUMMARY', requestId: 'test', length: 2, latestHash: 'a'.repeat(64), ancestor: null };
    it.each([
        { type: 'QUERY_BLOCKS', requestId: 'test', start: -1, length: 2, latestHash: 'a'.repeat(64), offset: 0 },
        { type: 'QUERY_BLOCKS', requestId: 'test', start: 2, length: 2, latestHash: 'a'.repeat(64), offset: 0 },
        { ...summary, length: Number.MAX_SAFE_INTEGER + 1 },
        { type: 'BLOCKS', requestId: 'test', start: 0, length: 2, latestHash: 'a'.repeat(64), blocks: [] },
        { type: 'BLOCKS', requestId: 'test', start: 0, length: 2, latestHash: 'a'.repeat(64), offset: 0,
            total: config.P2P_SYNC_MAX_BYTES + 1, data: 'e30=' }
    ])('rejects malformed or excessive ranges: $type', message => {
        expect(() => validateMessage(message, MESSAGE_TYPES)).toThrow();
    });
    it('ignores stale responses and rejects out-of-order batches without adopting a partial chain', () => {
        const f = fixture();
        try {
            f.sync.handle(f.ws, { ...summary, requestId: 'old' });
            expect(f.sent).toHaveLength(1);
            f.sync.handle(f.ws, summary);
            expect(() => f.sync.handle(f.ws, { type: 'BLOCKS', requestId: 'test', start: 1,
                length: 2, latestHash: summary.latestHash, blocks: [f.chain.chain[0]] })).toThrow('unexpected block range');
            expect(f.onChain).not.toHaveBeenCalled();
        } finally { f.sync.cancel(f.ws, 'test'); }
    });
    it('bounds the full candidate download and releases state on disconnect', () => {
        const f = fixture(), oldLimit = config.P2P_SYNC_MAX_BYTES;
        try {
            f.sync.handle(f.ws, summary); config.P2P_SYNC_MAX_BYTES = 1;
            expect(() => f.sync.handle(f.ws, { type: 'BLOCKS', requestId: 'test', start: 0,
                length: 2, latestHash: summary.latestHash, blocks: [f.chain.chain[0]] })).toThrow('chain download limit');
            f.ws.emit('close');
            expect(f.sync.active(f.ws)).toBe(false);
            expect(f.onFailure).toHaveBeenCalledWith(f.ws, 'test');
        } finally { config.P2P_SYNC_MAX_BYTES = oldLimit; f.sync.cancel(f.ws, 'test'); }
    });
    it('expires stalled transfers and limits branch-change restarts', () => {
        vi.useFakeTimers(); const f = fixture();
        try {
            vi.advanceTimersByTime(config.SYNC_TIMEOUT);
            expect(f.sync.active(f.ws)).toBe(false);
            f.sync.request(f.ws, 'test');
            for (let i = 0; i < 4; i++) f.sync.handle(f.ws, { type: 'SYNC_RESTART', requestId: 'test' });
            expect(f.sync.active(f.ws)).toBe(false);
            expect(f.onFailure).toHaveBeenCalledTimes(2);
        } finally { f.sync.cancel(f.ws, 'test'); vi.useRealTimers(); }
    });
});
