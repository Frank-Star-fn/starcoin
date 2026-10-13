const { EventEmitter } = require('events');
const http = require('http');
const config = require('../../src/config');
const { createPendingSync } = require('../../src/p2p/pending-sync');
const { validateMessage, receiveMessages } = require('../../src/p2p/message-security');
const { createP2P, MESSAGE_TYPES } = require('../../src/p2p/p2p');
const { EvmBlockchain } = require('../../src/evm/blockchain');
const { generateWallet } = require('../../src/core');
const { messageBudget } = require('../../src/mempool-policy');

const settings = ['P2P_MAX_PAYLOAD', 'P2P_MAX_TRANSACTIONS', 'P2P_MAX_MESSAGES', 'MEMPOOL_MAX_TXS', 'MEMPOOL_MAX_BYTES'];
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
function transactions(count, note = '') {
    return Array.from({ length: count }, (_, i) => ({ id: i.toString(16).padStart(64, '0'), nonce: i, note }));
}
function pair(pending, merge = vi.fn()) {
    const ws = new EventEmitter(), responses = [], requests = [], chain = { pendingTransactions: pending };
    const senderNetwork = { nodeInfo: { url: 'ws://localhost:3000' }, sendMessage: (_ws, message) => responses.push(message),
        broadcast: message => responses.push(message) };
    const receiverNetwork = { nodeInfo: { url: 'ws://localhost:3001' }, sendMessage: (_ws, message) => requests.push(message) };
    const sender = createPendingSync(senderNetwork, chain, () => {}), receiver = createPendingSync(receiverNetwork, {}, merge);
    return { ws, responses, requests, sender, receiver, merge, chain };
}

describe('bounded pending transaction pages', () => {
    let original;
    beforeEach(() => { original = Object.fromEntries(settings.map(key => [key, config[key]])); vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); Object.assign(config, original); });

    it('keeps legacy single-page responses compatible', () => {
        const link = pair(transactions(2)); link.sender.broadcast();
        expect(link.responses[0]).toEqual({ type: 'PENDING_TXS', transactions: link.chain.pendingTransactions, fromNode: 'ws://localhost:3000' });
        link.receiver.receive(link.ws, link.responses[0]); expect(link.merge).toHaveBeenCalledWith(link.chain.pendingTransactions, 'ws://localhost:3000');
        expect(link.requests).toHaveLength(0);
    });

    it.each(['count', 'bytes'])('transfers every transaction within %s bounds, with one page in flight', async bound => {
        config.P2P_MAX_TRANSACTIONS = bound === 'count' ? 2 : 1000;
        config.P2P_MAX_PAYLOAD = bound === 'bytes' ? 4096 : original.P2P_MAX_PAYLOAD;
        const pending = transactions(11, bound === 'bytes' ? '界'.repeat(300) : ''), merged = [];
        const link = pair(pending, batch => merged.push(...batch)); link.sender.broadcast();
        for (let page = 0; page < 20; page++) {
            const message = link.responses.shift();
            expect(message).toBeDefined(); expect(message.transactions.length).toBeLessThanOrEqual(config.P2P_MAX_TRANSACTIONS);
            expect(bytes(message)).toBeLessThanOrEqual(messageBudget()); expect(bytes(message)).toBeLessThanOrEqual(config.P2P_MAX_PAYLOAD);
            expect(() => validateMessage(message, MESSAGE_TYPES)).not.toThrow();
            await link.receiver.receive(link.ws, message);
            expect(link.requests).toHaveLength(0);
            if (message.next === null) break;
            await vi.advanceTimersByTimeAsync(250);
            expect(link.requests).toHaveLength(1);
            const request = link.requests.shift(); expect(() => validateMessage(request, MESSAGE_TYPES)).not.toThrow();
            link.sender.reply(link.ws, request);
        }
        expect(merged).toEqual(pending);
        await vi.advanceTimersByTimeAsync(1000); expect(link.requests).toHaveLength(0);
    });

    it('accepts exactly the total byte boundary across pages', async () => {
        config.P2P_MAX_TRANSACTIONS = 1;
        const pending = transactions(2, '界'); config.MEMPOOL_MAX_BYTES = bytes(pending);
        const link = pair(pending); link.sender.broadcast();
        await link.receiver.receive(link.ws, link.responses.shift()); await vi.advanceTimersByTimeAsync(250);
        link.sender.reply(link.ws, link.requests.shift()); await link.receiver.receive(link.ws, link.responses.shift());
        expect(link.merge).toHaveBeenCalledTimes(2);
    });

    it('waits for asynchronous merging before requesting the next page', async () => {
        config.P2P_MAX_TRANSACTIONS = 1;
        let finish; const merge = vi.fn(() => new Promise(resolve => { finish = resolve; }));
        const link = pair(transactions(2), merge); link.sender.broadcast();
        const work = link.receiver.receive(link.ws, link.responses.shift());
        await vi.advanceTimersByTimeAsync(1000); expect(link.requests).toHaveLength(0);
        finish(); await work; await vi.advanceTimersByTimeAsync(250); expect(link.requests).toHaveLength(1);
        link.ws.emit('close');
    });

    it('restarts when the pool changes, and bounds repeated restarts', async () => {
        config.P2P_MAX_TRANSACTIONS = 1;
        const link = pair(transactions(4)); link.sender.broadcast();
        await link.receiver.receive(link.ws, link.responses.shift());
        for (let round = 0; round < 3; round++) {
            await vi.advanceTimersByTimeAsync(250); const request = link.requests.shift(); expect(request).toBeDefined();
            link.chain.pendingTransactions = transactions(4, 'new-' + round);
            // IDs also change when signed transaction contents change.
            link.chain.pendingTransactions[0].id = (100 + round).toString(16).padStart(64, '0');
            link.sender.reply(link.ws, request); const response = link.responses.shift(); expect(response.cursor).toBe(0);
            await link.receiver.receive(link.ws, response);
        }
        expect(link.merge).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(1000); expect(link.requests).toHaveLength(0);
    });

    it('stops a download at the local pool count limit without closing the peer', async () => {
        config.P2P_MAX_TRANSACTIONS = 1; config.MEMPOOL_MAX_TXS = 2;
        const link = pair(transactions(4)); link.sender.broadcast();
        for (let i = 0; i < 3; i++) {
            await link.receiver.receive(link.ws, link.responses.shift());
            await vi.advanceTimersByTimeAsync(250);
            if (i < 2) link.sender.reply(link.ws, link.requests.shift());
        }
        expect(link.merge).toHaveBeenCalledTimes(2); expect(link.requests).toHaveLength(0);
    });

    it('pauses pool requests until the chain download finishes and cancels on close', async () => {
        const link = pair(transactions(2)); let paused = true;
        const receiver = createPendingSync({ nodeInfo: { url: 'ws://localhost:3001' }, sendMessage: (_ws, message) => link.requests.push(message) }, {}, link.merge, () => paused);
        link.sender.broadcast(); receiver.receive(link.ws, link.responses.shift());
        await vi.advanceTimersByTimeAsync(1000); expect(link.requests).toHaveLength(0); expect(link.merge).not.toHaveBeenCalled();
        paused = false; await vi.advanceTimersByTimeAsync(250); expect(link.requests).toHaveLength(1);
        expect(link.requests[0].cursor).toBeUndefined(); link.ws.emit('close');
        await vi.advanceTimersByTimeAsync(1000); expect(link.requests).toHaveLength(1);
    });

    it.each([
        { poolId: 'bad', cursor: 0, next: 1 },
        { poolId: '0'.repeat(64), cursor: -1, next: 1 },
        { poolId: '0'.repeat(64), cursor: 0, next: 2 },
        { poolId: '0'.repeat(64), cursor: 0, next: 0 },
    ])('rejects malformed pagination metadata %j', fields => {
        expect(() => validateMessage({ type: 'PENDING_TXS', transactions: transactions(1), ...fields }, MESSAGE_TYPES)).toThrow();
    });

    it('limits request rate while a pool needs more than eight pages', async () => {
        config.P2P_MAX_TRANSACTIONS = 1; config.P2P_MAX_MESSAGES = 30;
        const link = pair(transactions(12)); link.ws.close = vi.fn();
        const reply = new EventEmitter(); reply.close = vi.fn();
        const receiver = createPendingSync({ nodeInfo: { url: 'ws://localhost:3001' }, sendMessage: (_ws, message) => {
            reply.emit('message', Buffer.from(JSON.stringify(message)), false);
        } }, {}, link.merge);
        receiveMessages(reply, MESSAGE_TYPES, request => {
            link.sender.reply(link.ws, request);
            link.ws.emit('message', Buffer.from(JSON.stringify(link.responses.shift())), false);
        }, () => {});
        receiveMessages(link.ws, MESSAGE_TYPES, message => receiver.receive(link.ws, message), () => {});
        link.sender.broadcast(); link.ws.emit('message', Buffer.from(JSON.stringify(link.responses.shift())), false);
        await vi.advanceTimersByTimeAsync(30000);
        expect(link.merge).toHaveBeenCalledTimes(12); expect(link.ws.close).not.toHaveBeenCalled(); expect(reply.close).not.toHaveBeenCalled();
        link.ws.emit('close');
    });
});

describe('paged pool over real WebSockets', () => {
    it('replicates a signed pool across multiple pages and keeps the connection open', async () => {
        const original = Object.fromEntries(settings.map(key => [key, config[key]])), nodes = [];
        Object.assign(config, { P2P_MAX_PAYLOAD: 4096, P2P_MAX_TRANSACTIONS: 2 });
        try {
            for (let i = 0; i < 2; i++) {
                const chain = new EvmBlockchain(45981 + i, true, { consensus: { initialDifficulty: 0, difficultyMin: 0,
                    coinbaseMaturity: 0, difficultyAdjustInterval: 1000000, activationHeight: 1 }, rpc: { activationHeight: 1 } });
                await chain.ready; const server = http.createServer();
                await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
                nodes.push({ chain, server, port: server.address().port });
            }
            const [source, target] = nodes, wallet = generateWallet(); await source.chain.mineBlock(wallet.address);
            await target.chain.replaceChain(source.chain.chain);
            for (let nonce = 0; nonce < 12; nonce++) {
                const tx = source.chain.createTransaction(wallet.address, 'a'.repeat(32), '1', '0', '界'.repeat(100), 'STC', nonce);
                tx.signTransaction(wallet.privateKey, wallet.publicKey); await source.chain.addTransaction(tx);
            }
            for (const node of nodes) node.p2p = createP2P(node.server, node.chain, node.port);
            target.p2p.connectToPeer('ws://127.0.0.1:' + source.port);
            const deadline = Date.now() + 7000;
            while (target.chain.pendingTransactions.length < 12 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
            expect(target.chain.pendingTransactions.map(tx => tx.id)).toEqual(source.chain.pendingTransactions.map(tx => tx.id));
            expect(target.p2p.getConnectedCount()).toBeGreaterThan(0); expect(source.p2p.wss.clients.size).toBe(1);
        } finally {
            for (const node of nodes) {
                node.p2p?.stopDiscovery(); node.p2p?.stopHealthCheck();
                for (const url of node.p2p?.getNodeUrls() || []) node.p2p.disconnectFromPeer(url);
                for (const ws of node.p2p?.wss.clients || []) ws.terminate();
                node.p2p?.wss.close(); await new Promise(resolve => node.server.close(resolve));
            }
            Object.assign(config, original);
        }
    }, 15000);
});
