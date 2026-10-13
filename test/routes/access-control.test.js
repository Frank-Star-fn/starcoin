const express = require('express');
const request = require('supertest');
const config = require('../../src/config');
const createRoutes = require('../../src/routes');
const { protectHttp } = require('../../src/middleware/access-control');
const { createMockStarCoin, createMockP2P } = require('../helpers');

describe('node access boundaries', () => {
    let app, chain, p2p;
    const previous = config.ADMIN_TOKEN;
    beforeEach(() => {
        config.ADMIN_TOKEN = 'test-admin-token';
        chain = createMockStarCoin(); p2p = createMockP2P();
        chain.clearDataFile = vi.fn(() => true); chain.mineBlockAsync = vi.fn(chain.mineBlockAsync);
        p2p.connectToPeer = vi.fn();
        app = express(); app.use(protectHttp, express.json());
        app.use('/api', createRoutes(chain, p2p, () => {}, 3000));
    });
    afterEach(() => { config.ADMIN_TOKEN = previous; });
    it.each(['/storage/reset', '/storage/import', '/storage/reload', '/connect', '/disconnect',
        '/sync', '/mempool/sync', '/mempool/broadcast', '/discovery/start', '/discovery/stop', '/discovery/scan',
        '/mine', '/mine/start', '/mine/stop', '/Storage/reset/', '/CONNECT/', '/MINE/start/'])('rejects unauthenticated %s without side effects', async path => {
        await request(app).post('/api' + path).send({}).expect(401);
        expect(chain.clearDataFile).not.toHaveBeenCalled();
        expect(chain.mineBlockAsync).not.toHaveBeenCalled(); expect(p2p.connectToPeer).not.toHaveBeenCalled();
    });
    it('disables management without a configured token and leaves queries public', async () => {
        config.ADMIN_TOKEN = '';
        await request(app).post('/api/storage/reset').send({}).expect(503);
        await request(app).get('/api/openapi.json').expect(200);
    });
    it('rejects bad credentials, cross-origin requests, and untrusted Host', async () => {
        await request(app).post('/api/storage/reset').set('Authorization', 'Bearer wrong').expect(401);
        await request(app).post('/api/storage/reset').set('Authorization', 'Bearer test-admin-token')
            .set('Origin', 'https://attacker.example').expect(403);
        await request(app).get('/api/openapi.json').set('Host', 'attacker.example').expect(403);
        await request(app).post('/api/storage/reset').set('Authorization', 'Bearer test-admin-token').expect(200);
        expect(chain.clearDataFile).toHaveBeenCalledTimes(1);
    });
    it('accepts HTTPS websocket origins only when forwarded by a trusted proxy', () => {
        const { sameOrigin } = require('../../src/middleware/access-control');
        const req = { headers: { host: 'localhost:3000', origin: 'https://localhost:3000', 'x-forwarded-proto': 'https' }, socket: { remoteAddress: '127.0.0.1' } };
        expect(sameOrigin(req, () => true)).toBe(true); expect(sameOrigin(req, () => false)).toBe(false);
    });
    it('GET progress cannot initiate mining', async () => {
        await request(app).get('/api/mine/stream?minerAddress=evil').expect(401);
        await request(app).get('/api/mine/stream?minerAddress=evil').set('Authorization', 'Bearer test-admin-token').expect(404);
        expect(chain.mineBlockAsync).not.toHaveBeenCalled();
    });
    it('allows one mining job and stops it through the authenticated POST', async () => {
        chain.mineBlockAsync.mockImplementation((_address, _data, _progress, cancel) => new Promise(resolve => {
            const timer = setInterval(() => { if (cancel()) { clearInterval(timer); resolve({ canceled: true }); } }, 5);
        }));
        const start = await request(app).post('/api/mine/start').set('Authorization', 'Bearer test-admin-token').send({}).expect(202);
        await request(app).post('/api/mine/start').set('Authorization', 'Bearer test-admin-token').send({}).expect(409);
        await request(app).post('/api/mine/stop').send({ jobId: start.body.jobId }).expect(401);
        await request(app).post('/api/mine/stop').set('Authorization', 'Bearer test-admin-token').send({ jobId: start.body.jobId }).expect(200);
    });
    it('bounds simultaneous progress subscriptions independently of request headers', async () => {
        const previousLimit = config.MINING_MAX_STREAMS; config.MINING_MAX_STREAMS = 1;
        const server = require('http').createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const url = 'http://127.0.0.1:' + server.address().port;
        const headers = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' };
        chain.mineBlockAsync.mockImplementation((_address, _data, _progress, cancel) => new Promise(resolve => {
            const timer = setInterval(() => { if (cancel()) { clearInterval(timer); resolve({ canceled: true }); } }, 5);
        }));
        let first;
        try {
            const job = await (await fetch(url + '/api/mine/start', { method: 'POST', headers, body: '{}' })).json();
            first = await fetch(url + '/api/mine/stream?jobId=' + job.jobId, { headers }); expect(first.status).toBe(200);
            const second = await fetch(url + '/api/mine/stream?jobId=' + job.jobId, { headers: { ...headers, 'X-Forwarded-For': '8.8.8.8' } });
            expect(second.status).toBe(429);
            await fetch(url + '/api/mine/stop', { method: 'POST', headers, body: JSON.stringify({ jobId: job.jobId }) });
        } finally { await first?.body.cancel(); config.MINING_MAX_STREAMS = previousLimit;
            server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    });
});
