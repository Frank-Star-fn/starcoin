// ============================================================
// routes/api-chain.test.js — 区块链信息与验证路由测试
// ============================================================
const express = require('express');
const request = require('supertest');
const createChainRoutes = require('../../src/routes/api-chain');
const { createMockStarCoin, createMockP2P } = require('../helpers');

describe('api-chain 路由 — 区块链信息与验证', () => {
  let starCoin, p2p, app;

  beforeEach(() => {
    starCoin = createMockStarCoin();
    p2p = createMockP2P();
    app = express();
    app.use(express.json());
    app.use(createChainRoutes(starCoin, p2p, 3000));
  });

  // ============================================================
  // GET /blockchain
  // ============================================================
  describe('GET /blockchain', () => {
    it('返回 200 并包含 chain 和 isValid', async () => {
      const res = await request(app).get('/blockchain');
      expect(res.status).toBe(200);
      expect(res.body.chain).toBeDefined();
      expect(res.body.isValid).toBe(true);
    });

    it('返回 stats 对象包含区块链统计信息', async () => {
      const res = await request(app).get('/blockchain');
      expect(res.body.stats).toBeDefined();
      expect(res.body.stats.totalBlocks).toBe(1);
      expect(res.body.stats.difficulty).toBe(4);
      expect(res.body.stats.targetBlockTime).toBe(10000);
      expect(res.body.stats.genesisBlock).toMatch(/^0000.*\.\.\.$/);
      expect(res.body.stats.connectedNodes).toBe(0);
      expect(res.body.stats.totalBurnedFees).toBe(0);
      expect(res.body.stats.recentBurnedFees).toEqual([]);
      expect(Array.isArray(res.body.stats.difficultyHistory)).toBe(true);
    });

    it('返回 port 和 nodeInfo', async () => {
      const res = await request(app).get('/blockchain');
      expect(res.body.port).toBe(3000);
      expect(res.body.nodeInfo).toEqual({ id: 'test-node-id', port: 3000 });
    });

    it('isValid 反映链的真实状态', async () => {
      starCoin.isChainValid = () => false;
      const res = await request(app).get('/blockchain');
      expect(res.body.isValid).toBe(false);
    });

    it('connectedNodes 反映 P2P 连接数', async () => {
      p2p.getConnectedCount = () => 5;
      const res = await request(app).get('/blockchain');
      expect(res.body.stats.connectedNodes).toBe(5);
    });
  });

  // ============================================================
  // GET /validate
  // ============================================================
  describe('GET /validate', () => {
    it('返回 200 并包含 isValid = true', async () => {
      const res = await request(app).get('/validate');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.isValid).toBe(true);
    });

    it('返回 totalBlocks', async () => {
      const res = await request(app).get('/validate');
      expect(res.body.totalBlocks).toBe(1);
    });

    it('链无效时 isValid = false', async () => {
      starCoin.isChainValid = () => false;
      const res = await request(app).get('/validate');
      expect(res.body.isValid).toBe(false);
    });
  });
});