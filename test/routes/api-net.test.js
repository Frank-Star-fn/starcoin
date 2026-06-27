// ============================================================
// routes/api-net.test.js — P2P 同步 + 数据持久化 + 节点连接 + 发现路由测试
// ============================================================
const express = require('express');
const request = require('supertest');
const createNetRoutes = require('../../src/routes/api-net');
const { createMockStarCoin, createMockP2P } = require('../helpers');

describe('api-net 路由 — 网络、同步、存储、节点', () => {
  let starCoin, p2p, app;

  beforeEach(() => {
    starCoin = createMockStarCoin();
    p2p = createMockP2P();
    app = express();
    app.use(express.json());
    app.use(createNetRoutes(starCoin, p2p, 3000));
  });

  // ============================================================
  // POST /sync
  // ============================================================
  describe('POST /sync', () => {
    it('返回 200 并包含同步结果', async () => {
      const res = await request(app).post('/sync');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('同步完成');
      expect(res.body.blocksReceived).toBe(0);
    });

    it('返回链有效性和同步状态', async () => {
      const res = await request(app).post('/sync');
      expect(res.body.valid).toBe(true);
      expect(res.body.syncState).toBeDefined();
      expect(res.body.syncState.isSyncing).toBe(false);
    });
  });

  // ============================================================
  // GET /sync/status
  // ============================================================
  describe('GET /sync/status', () => {
    it('返回 200 并包含同步状态详情', async () => {
      const res = await request(app).get('/sync/status');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.isSyncing).toBe(false);
      expect(res.body.selfChain).toBeDefined();
      expect(res.body.selfChain.length).toBe(1);
      expect(res.body.selfChain.valid).toBe(true);
      expect(res.body.connectedNodes).toBe(0);
    });

    it('返回最新的链信息', async () => {
      starCoin.getLatestBlock = () => ({ hash: 'abc123', index: 5 });
      const res = await request(app).get('/sync/status');
      expect(res.body.selfChain.latestHash).toBe('abc123');
    });

    it('包含候选链摘要', async () => {
      const res = await request(app).get('/sync/status');
      expect(Array.isArray(res.body.peerChains)).toBe(true);
      expect(res.body.candidates).toBe(0);
    });
  });

  // ============================================================
  // POST /mempool/sync
  // ============================================================
  describe('POST /mempool/sync', () => {
    it('同步交易池返回 200', async () => {
      const res = await request(app).post('/mempool/sync');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('交易池同步完成');
      expect(res.body.poolCount).toBe(0);
      expect(res.body.connectedNodes).toBe(0);
    });
  });

  // ============================================================
  // POST /mempool/broadcast
  // ============================================================
  describe('POST /mempool/broadcast', () => {
    it('广播交易池返回 200', async () => {
      starCoin.pendingTransactions = [{ id: 'tx1' }, { id: 'tx2' }];
      const res = await request(app).post('/mempool/broadcast');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.poolCount).toBe(2);
      expect(res.body.message).toContain('2');
    });

    it('空交易池广播时返回 0', async () => {
      const res = await request(app).post('/mempool/broadcast');
      expect(res.body.poolCount).toBe(0);
    });
  });

  // ============================================================
  // GET /storage/status
  // ============================================================
  describe('GET /storage/status', () => {
    it('返回 200 并包含存储状态', async () => {
      const res = await request(app).get('/storage/status');
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.file).toBe('/tmp/test_starcoin_data.json');
      expect(res.body.exists).toBeDefined();
      expect(typeof res.body.size).toBe('number');
      expect(res.body.totalBlocks).toBe(1);
    });
  });

  // ============================================================
  // POST /storage/save
  // ============================================================
  describe('POST /storage/save', () => {
    it('保存成功返回 200', async () => {
      const res = await request(app).post('/storage/save');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('已保存');
      expect(res.body.totalBlocks).toBe(1);
    });

    it('保存失败返回 success = false', async () => {
      starCoin.saveToFile = () => false;
      const res = await request(app).post('/storage/save');
      expect(res.body.success).toBe(false);
    });
  });

  // ============================================================
  // POST /storage/reload
  // ============================================================
  describe('POST /storage/reload', () => {
    it('重新加载成功返回 200', async () => {
      const res = await request(app).post('/storage/reload');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('已从本地文件重新加载');
    });

    it('加载失败时返回对应消息', async () => {
      starCoin.loadFromFile = () => false;
      const res = await request(app).post('/storage/reload');
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('无法从文件加载');
    });
  });

  // ============================================================
  // POST /storage/reset
  // ============================================================
  describe('POST /storage/reset', () => {
    it('重置成功广播并返回 200', async () => {
      const res = await request(app).post('/storage/reset');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('已重置');
    });

    it('重置失败返回 false', async () => {
      starCoin.clearDataFile = () => false;
      const res = await request(app).post('/storage/reset');
      expect(res.body.success).toBe(false);
    });
  });

  // ============================================================
  // GET /storage/export
  // ============================================================
  describe('GET /storage/export', () => {
    it('返回 200 并导出链数据', async () => {
      const res = await request(app).get('/storage/export');
      expect(res.status).toBe(200);
      expect(res.body.chain).toBeDefined();
      expect(res.body.exportedAt).toBeDefined();
      expect(res.body.port).toBe(3000);
    });

    it('设置 Content-Disposition 响应头', async () => {
      const res = await request(app).get('/storage/export');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-disposition']).toContain('starcoin_chain');
    });
  });

  // ============================================================
  // POST /storage/import
  // ============================================================
  describe('POST /storage/import', () => {
    it('有效链数据导入成功', async () => {
      const validChain = [
        { index: 0, timestamp: '2025-01-01', transactions: [], previousHash: '0'.repeat(64), nonce: 0, hash: '0'.repeat(64) },
        { index: 1, timestamp: '2025-01-02', transactions: [], previousHash: '0'.repeat(64), nonce: 1, hash: '1'.repeat(64) },
      ];
      starCoin.isChainValid = () => true;

      const res = await request(app)
        .post('/storage/import')
        .send({ chain: validChain });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('已导入');
      expect(res.body.totalBlocks).toBe(2);
    });

    it('无效链数据返回 400', async () => {
      const res = await request(app)
        .post('/storage/import')
        .send({ chain: null });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('无效');
    });

    it('空数组链数据返回 400', async () => {
      const res = await request(app)
        .post('/storage/import')
        .send({ chain: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('无效');
    });

    it('链验证失败时返回 400', async () => {
      starCoin.isChainValid = () => false;
      const res = await request(app)
        .post('/storage/import')
        .send({ chain: [{ index: 0 }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('验证失败');
    });
  });

  // ============================================================
  // POST /connect
  // ============================================================
  describe('POST /connect', () => {
    it('连接节点成功返回 200', async () => {
      const res = await request(app)
        .post('/connect')
        .send({ peerUrl: 'ws://localhost:3001' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('ws://localhost:3001');
    });

    it('缺少 peerUrl 返回 400', async () => {
      const res = await request(app).post('/connect').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('节点URL不能为空');
    });
  });

  // ============================================================
  // POST /disconnect
  // ============================================================
  describe('POST /disconnect', () => {
    it('断开节点成功返回 200', async () => {
      const res = await request(app)
        .post('/disconnect')
        .send({ peerUrl: 'ws://localhost:3001' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('已断开');
    });

    it('缺少 peerUrl 返回 400', async () => {
      const res = await request(app).post('/disconnect').send({});
      expect(res.status).toBe(400);
    });
  });

  // ============================================================
  // GET /nodes
  // ============================================================
  describe('GET /nodes', () => {
    it('返回节点列表和当前节点信息', async () => {
      p2p.getNodeUrls = () => ['ws://localhost:3001', 'ws://localhost:3002'];
      p2p.getConnectedCount = () => 2;
      const res = await request(app).get('/nodes');
      expect(res.status).toBe(200);
      expect(res.body.nodes).toEqual(['ws://localhost:3001', 'ws://localhost:3002']);
      expect(res.body.count).toBe(2);
      expect(res.body.currentNode).toEqual({ id: 'test-node-id', port: 3000 });
    });
  });

  // ============================================================
  // GET /all-nodes
  // ============================================================
  describe('GET /all-nodes', () => {
    it('返回所有节点信息', async () => {
      p2p.getAllNodeInfo = () => Promise.resolve([
        { id: 'node1', port: 3001 },
        { id: 'node2', port: 3002 },
      ]);
      const res = await request(app).get('/all-nodes');
      expect(res.status).toBe(200);
      expect(res.body.nodes).toHaveLength(2);
      expect(res.body.total).toBe(2);
    });
  });

  // ============================================================
  // GET /discovery/status
  // ============================================================
  describe('GET /discovery/status', () => {
    it('返回发现状态', async () => {
      const res = await request(app).get('/discovery/status');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.discovery).toBeDefined();
      expect(res.body.discovery.running).toBe(false);
      expect(res.body.discovery.interval).toBe(30000);
    });
  });

  // ============================================================
  // POST /discovery/start
  // ============================================================
  describe('POST /discovery/start', () => {
    it('启动发现返回 200', async () => {
      const res = await request(app).post('/discovery/start');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('已启动');
      expect(res.body.status).toBeDefined();
    });
  });

  // ============================================================
  // POST /discovery/stop
  // ============================================================
  describe('POST /discovery/stop', () => {
    it('停止发现返回 200', async () => {
      const res = await request(app).post('/discovery/stop');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('已停止');
      expect(res.body.status).toBeDefined();
    });
  });
});