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
        '/mine', '/mine/start', '/mine/stop'])('rejects unauthenticated %s without side effects', async path => {
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
});
