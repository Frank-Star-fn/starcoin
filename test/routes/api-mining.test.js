// ============================================================
// routes/api-mining.test.js — 挖矿路由测试
// ============================================================
const express = require('express');
const request = require('supertest');
const createMiningRoutes = require('../../src/routes/api-mining');
const config = require('../../src/config');
const { createMockStarCoin, createMockP2P, createSpy } = require('../helpers');

describe('api-mining 路由 — 挖矿', () => {
  let starCoin, p2p, broadcastSpy, app;
  const previousToken = config.ADMIN_TOKEN;
  beforeAll(() => { config.ADMIN_TOKEN = 'test-admin'; });
  afterAll(() => { config.ADMIN_TOKEN = previousToken; });

  beforeEach(() => {
    starCoin = createMockStarCoin();
    p2p = createMockP2P();
    broadcastSpy = createSpy();
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.headers.authorization = 'Bearer test-admin'; next(); });
    app.use(createMiningRoutes(starCoin, p2p, broadcastSpy));
  });

  // ============================================================
  // POST /mine
  // ============================================================
  describe('POST /mine', () => {
    it('默认矿工地址挖矿成功返回 200', async () => {
      const res = await request(app).post('/mine').send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.block).toBeDefined();
      expect(res.body.block.index).toBe(6);
      expect(res.body.reward).toBe(50);
      expect(res.body.miningTime).toMatch(/\d+ms/);
    });

    it('指定矿工地址挖矿成功', async () => {
      const res = await request(app)
        .post('/mine')
        .send({ minerAddress: 'b'.repeat(32) });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('挖矿失败时返回 400', async () => {
      starCoin.mineBlock = () => { throw new Error('挖矿失败'); };
      const res = await request(app).post('/mine').send({});
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('挖矿失败');
    });

    it('挖矿成功后广播到 P2P 和前端', async () => {
      const broadcastLatestSpy = createSpy();
      const broadcastPendingSpy = createSpy();
      p2p.broadcastLatest = broadcastLatestSpy;
      p2p.broadcastPendingTxs = broadcastPendingSpy;

      await request(app).post('/mine').send({});

      expect(broadcastLatestSpy._callCount).toBe(1);
      expect(broadcastPendingSpy._callCount).toBe(1);
      expect(broadcastSpy._callCount).toBe(1);
    });

    it('挖矿成功后返回交易数量和奖励', async () => {
      starCoin.mineBlock = () => ({
        index: 10,
        hash: 'block_hash_abc',
        transactions: [{ id: 'tx1' }, { id: 'tx2' }],
        nonce: 12345,
        timestamp: Date.now(),
        previousHash: 'prev_hash',
      });
      const res = await request(app).post('/mine').send({});
      expect(res.body.transactionCount).toBe(2);
      expect(res.body.reward).toBe(50);
    });
  });

  // ============================================================
  // GET /mine/stream — SSE 挖矿流（只做基本验证）
  // ============================================================
  describe('GET /mine/stream (SSE)', () => {
    it.each(['accepted', 'rejected'])('does not finish on a solved nonce before the block is %s', async outcome => {
      let report, finish, fail;
      const pending = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      starCoin.mineBlockAsync = (_address, _data, progress) => { report = progress; return pending; };
      const events = [];
      const fixture = express();
      fixture.use(express.json(), (req, res, next) => {
        req.headers.authorization = 'Bearer test-admin';
        if (req.path === '/mine/stream') {
          const write = res.write.bind(res);
          res.write = (chunk, ...args) => {
            if (typeof chunk === 'string' && chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)));
            return write(chunk, ...args);
          };
        }
        next();
      });
      fixture.use(createMiningRoutes(starCoin, p2p, broadcastSpy));
      const server = require('http').createServer(fixture);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = 'http://127.0.0.1:' + server.address().port;
      try {
        const start = await (await fetch(url + '/mine/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
        const stream = await fetch(url + '/mine/stream?jobId=' + start.jobId);
        const body = stream.text();
        report({ nonce: 1, found: false });
        report({ nonce: 2, found: true });
        expect(events.some(event => event.found)).toBe(false);
        await request(fixture).post('/mine/start').send({}).expect(409);
        if (outcome === 'accepted') finish(starCoin.mineBlock());
        else fail(new Error('候选区块验证失败'));
        await body;
        if (outcome === 'accepted') {
          expect(events.filter(event => event.found)).toHaveLength(1);
          expect(events.find(event => event.found).block.index).toBe(6);
          // The completion event permits an immediate new task.
          starCoin.mineBlockAsync = async () => starCoin.mineBlock();
          await request(fixture).post('/mine/start').send({}).expect(202);
        } else {
          expect(events.some(event => event.found)).toBe(false);
          expect(events.at(-1).error).toBeDefined();
        }
      } finally {
        finish(starCoin.mineBlock());
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    });

    it('返回 text/event-stream 响应头', async () => {
      const job = await request(app).post('/mine/start').send({});
      // SSE 是长连接，这里只验证初始响应头
      const res = await request(app)
        .get('/mine/stream?jobId=' + job.body.jobId)
        .buffer(false)
        .parse((res, cb) => {
          let data = '';
          res.on('data', chunk => { data += chunk.toString(); });
          res.on('end', () => {
            // 只消费第一个事件后就结束
            cb(null, data);
            res.destroy();
          });
        })
        .timeout(5000);

      // 验证 SSE 响应头
      expect(res.headers['content-type']).toBe('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['connection']).toBe('keep-alive');
    }, 10000);
  });
});
