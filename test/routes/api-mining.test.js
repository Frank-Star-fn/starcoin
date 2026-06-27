// ============================================================
// routes/api-mining.test.js — 挖矿路由测试
// ============================================================
const express = require('express');
const request = require('supertest');
const createMiningRoutes = require('../../src/routes/api-mining');
const { createMockStarCoin, createMockP2P, createSpy } = require('../helpers');

describe('api-mining 路由 — 挖矿', () => {
  let starCoin, p2p, broadcastSpy, app;

  beforeEach(() => {
    starCoin = createMockStarCoin();
    p2p = createMockP2P();
    broadcastSpy = createSpy();
    app = express();
    app.use(express.json());
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
        .send({ minerAddress: 'MY_MINER_ADDRESS' });
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
    it('返回 text/event-stream 响应头', async () => {
      // SSE 是长连接，这里只验证初始响应头
      const res = await request(app)
        .get('/mine/stream')
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
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['connection']).toBe('keep-alive');
    }, 10000);
  });
});