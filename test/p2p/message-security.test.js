const { EventEmitter, once } = require('events');
const http = require('http');
const WebSocket = require('ws');
const config = require('../../src/config');
const { receiveMessages, validPeerUrl } = require('../../src/p2p/message-security');
const { createP2PCore, MESSAGE_TYPES } = require('../../src/p2p/p2p-core');

describe('untrusted P2P messages', () => {
    function socket(handler = vi.fn()) {
        const ws = new EventEmitter(); ws.close = vi.fn();
        receiveMessages(ws, MESSAGE_TYPES, handler, vi.fn()); return ws;
    }
    it.each(['{', 'null', '[]', '42', '{}', '{"type":"UNKNOWN"}', '{"type":"NODE_INFO","node":null}',
        '{"type":"PENDING_TXS","transactions":[null]}'])('contains malformed payload %s', data => {
        const handler = vi.fn(), ws = socket(handler);
        expect(() => ws.emit('message', Buffer.from(data), false)).not.toThrow();
        expect(ws.close).toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
    });
    it.each([false, true])('contains handler failure, asynchronous=%s', async asynchronous => {
        const ws = socket(() => { if (asynchronous) return Promise.reject(new Error('bad')); throw new Error('bad'); });
        expect(() => ws.emit('message', Buffer.from('{"type":"PING"}'), false)).not.toThrow();
        await new Promise(resolve => setImmediate(resolve));
        expect(ws.close).toHaveBeenCalledWith(1008, expect.any(String));
    });
    it('rejects binary, oversized, deeply nested and excessive collection payloads', () => {
        let ws = socket(); ws.emit('message', Buffer.from('{"type":"PING"}'), true); expect(ws.close).toHaveBeenCalled();
        ws = socket(); ws.emit('message', Buffer.alloc(config.P2P_MAX_PAYLOAD + 1), false); expect(ws.close).toHaveBeenCalledWith(1009, expect.any(String));
        ws = socket(); const deep = '{"type":"PING","data":' + '['.repeat(40) + '0' + ']'.repeat(40) + '}';
        ws.emit('message', Buffer.from(deep), false); expect(ws.close).toHaveBeenCalled();
        ws = socket(); ws.emit('message', Buffer.from(JSON.stringify({ type: 'NODE_LIST', nodes: Array(33).fill('ws://localhost:3001') })), false);
        expect(ws.close).toHaveBeenCalled();
    });
    it('bounds queued work and serializes valid handlers', async () => {
        const handler = vi.fn(() => new Promise(() => {})), ws = socket(handler);
        for (let i = 0; i < 10; i++) ws.emit('message', Buffer.from('{"type":"PING"}'), false);
        expect(ws.close).toHaveBeenCalledWith(1008, expect.any(String));
        await new Promise(resolve => setImmediate(resolve)); expect(handler.mock.calls.length).toBeLessThanOrEqual(1);
    });
    it.each(['http://localhost:3000', 'ws://localhost:3000/ws', 'ws://user:secret@localhost:3000',
        'ws://169.254.169.254/', 'ws://unconfigured.example/'])('does not dial %s', url => {
        expect(validPeerUrl(url)).toBe(false);
    });
    it('survives malformed incoming and outgoing websocket traffic and accepts a new healthy peer', async () => {
        const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        const core = createP2PCore(server, { chain: [], getLatestBlock: () => ({}) }, port);
        const handler = vi.fn(); core.setHandler(handler);
        let attackerServer, attackerWss;
        try {
            const bad = new WebSocket(`ws://127.0.0.1:${port}`); await once(bad, 'open');
            const badClosed = once(bad, 'close'); bad.send('{'); await badClosed;
            const healthy = new WebSocket(`ws://127.0.0.1:${port}`); await once(healthy, 'open');
            healthy.send('{"type":"PING"}'); await vi.waitFor(() => expect(handler).toHaveBeenCalled());
            const healthyClosed = once(healthy, 'close'); healthy.close(); await healthyClosed;
            attackerServer = http.createServer(); await new Promise(resolve => attackerServer.listen(0, '127.0.0.1', resolve));
            attackerWss = new WebSocket.Server({ server: attackerServer });
            attackerWss.on('connection', ws => ws.send('null'));
            const closed = new Promise(resolve => attackerWss.once('connection', ws => ws.once('close', resolve)));
            core.connectToPeer(`ws://127.0.0.1:${attackerServer.address().port}`, false); await closed;
            expect(core.nodeConnections.size).toBe(0);
        } finally {
            for (const ws of core.wss.clients) ws.terminate();
            for (const conn of core.nodeConnections.values()) conn.ws.terminate();
            core.wss.close(); await new Promise(resolve => server.close(resolve));
            attackerWss?.close(); if (attackerServer) await new Promise(resolve => attackerServer.close(resolve));
        }
    });
    it('rejects browser P2P upgrades and foreign-origin frontend subscriptions', async () => {
        const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const core = createP2PCore(server, { chain: [] }, server.address().port);
        try {
            for (const path of ['/', '/ws']) {
                const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}${path}`, { origin: 'https://evil.example' });
                const error = await once(ws, 'error'); expect(error[0].message).toContain('401');
            }
        } finally { core.wss.close(); await new Promise(resolve => server.close(resolve)); }
    });
    it('closes a peer sending excessive tiny fragments below the byte-size limit', async () => {
        const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const core = createP2PCore(server, { chain: [] }, server.address().port);
        try {
            const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`); await once(ws, 'open');
            const closed = once(ws, 'close');
            for (let i = 0; i < 1025; i++) ws.send('x', { binary: false, fin: false });
            expect((await closed)[0]).toBe(1008);
        } finally { for (const ws of core.wss.clients) ws.terminate(); core.wss.close(); await new Promise(resolve => server.close(resolve)); }
    });
    it('bounds reconnect entries and rejects a peer that changes its advertised address', async () => {
        const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const core = createP2PCore(server, { chain: [] }, server.address().port); core.setHandler(() => {});
        try {
            for (let i = 0; i < 50; i++) core.reconnect.init('ws://localhost:' + (30000 + i));
            expect(core.reconnect.getState().size).toBe(config.P2P_MAX_CONNECTIONS);
            const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`); await once(ws, 'open');
            const closed = once(ws, 'close');
            ws.send(JSON.stringify({ type: 'NODE_INFO', node: { url: 'ws://localhost:30000' } }));
            ws.send(JSON.stringify({ type: 'NODE_INFO', node: { url: 'ws://localhost:30001' } }));
            expect((await closed)[0]).toBe(1008);
        } finally { for (const ws of core.wss.clients) ws.terminate(); core.wss.close(); await new Promise(resolve => server.close(resolve)); }
    });
});
