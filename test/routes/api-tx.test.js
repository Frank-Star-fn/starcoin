// ============================================================
// routes/api-tx.test.js — 钱包 + 交易 + 余额 + 交易池路由测试
// ============================================================
const express = require('express');
const request = require('supertest');
const { generateWallet } = require('../../src/blockchain');
const createTxRoutes = require('../../src/routes/api-tx');
const { createMockStarCoin, createMockP2P, createSpy } = require('../helpers');

describe('api-tx 路由 — 钱包、交易、余额、交易池', () => {
  let starCoin, p2p, broadcastSpy, app;

  beforeEach(() => {
    starCoin = createMockStarCoin();
    p2p = createMockP2P();
    broadcastSpy = createSpy();
    app = express();
    app.use(express.json());
    app.use(createTxRoutes(starCoin, broadcastSpy, p2p));
  });

  // ============================================================
  // POST /wallet/new
  // ============================================================
  describe('POST /wallet/new', () => {
    it('返回 200 并生成包含 privateKey/publicKey/address 的钱包', async () => {
      const res = await request(app).post('/wallet/new');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.wallet.privateKey).toBeTruthy();
      expect(res.body.wallet.publicKey).toBeTruthy();
      expect(res.body.wallet.address).toBeTruthy();
    });

    it('私钥为 PEM 格式', async () => {
      const res = await request(app).post('/wallet/new');
      expect(res.body.wallet.privateKey.startsWith('-----BEGIN')).toBe(true);
    });

    it('每次生成不同的钱包', async () => {
      const [r1, r2] = await Promise.all([
        request(app).post('/wallet/new'),
        request(app).post('/wallet/new'),
      ]);
      expect(r1.body.wallet.address).not.toBe(r2.body.wallet.address);
    });
  });

  // ============================================================
  // POST /wallet/import
  // ============================================================
  describe('POST /wallet/import', () => {
    it('用有效 PEM 导入返回 200 和钱包信息', async () => {
      const wallet = generateWallet();
      const res = await request(app)
        .post('/wallet/import')
        .send({ privateKeyPem: wallet.privateKey });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.wallet.address).toBe(wallet.address);
      expect(res.body.wallet.publicKey).toBe(wallet.publicKey);
    });

    it('缺少 privateKeyPem 返回 400', async () => {
      const res = await request(app).post('/wallet/import').send({});
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('必须提供 privateKeyPem');
    });

    it('无效 PEM 返回 400', async () => {
      const res = await request(app)
        .post('/wallet/import')
        .send({ privateKeyPem: 'INVALID_PEM_DATA' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('私钥导入失败');
    });
  });

  // ============================================================
  // POST /wallet/verify-pem
  // ============================================================
  describe('POST /wallet/verify-pem', () => {
    it('有效 PEM 返回 publicKey 和 address', async () => {
      const wallet = generateWallet();
      const res = await request(app)
        .post('/wallet/verify-pem')
        .send({ privateKeyPem: wallet.privateKey });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.publicKey).toBe(wallet.publicKey);
      expect(res.body.address).toBe(wallet.address);
    });

    it('缺少 privateKeyPem 返回 400', async () => {
      const res = await request(app).post('/wallet/verify-pem').send({});
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('无效 PEM 返回 400', async () => {
      const res = await request(app)
        .post('/wallet/verify-pem')
        .send({ privateKeyPem: 'bad' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ============================================================
  // POST /transaction
  // ============================================================
  describe('POST /transaction', () => {
    let wallet;

    beforeEach(() => {
      wallet = generateWallet();
    });

    it('提交带有效签名的交易返回 200', async () => {
      starCoin.addTransaction = (tx) => tx;
      const res = await request(app)
        .post('/transaction')
        .send({
          from: wallet.address,
          to: 'recipient_addr',
          amount: 10,
          fee: 1,
          note: '测试转账',
          privateKey: wallet.privateKey,
          publicKey: wallet.publicKey,
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.transaction).toBeDefined();
      expect(res.body.poolCount).toBe(0);
    });

    it('缺少 from/to/amount 返回 400', async () => {
      const res = await request(app)
        .post('/transaction')
        .send({ privateKey: 'x', publicKey: 'y' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('必须提供 from, to, amount');
    });

    it('缺少 privateKey/publicKey 返回 400', async () => {
      const res = await request(app)
        .post('/transaction')
        .send({ from: 'a', to: 'b', amount: 10 });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('必须提供 privateKey 和 publicKey');
    });

    it('addTransaction 抛出异常时返回 400', async () => {
      starCoin.addTransaction = () => { throw new Error('余额不足'); };
      const res = await request(app)
        .post('/transaction')
        .send({
          from: wallet.address, to: 'b', amount: 99999,
          privateKey: wallet.privateKey, publicKey: wallet.publicKey,
        });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('余额不足');
    });

    it('成功提交后广播交易到 P2P 和前端', async () => {
      starCoin.addTransaction = (tx) => tx;
      const broadcastTxSpy = createSpy();
      p2p.broadcastTransaction = broadcastTxSpy;

      await request(app)
        .post('/transaction')
        .send({
          from: wallet.address, to: 'b', amount: 10,
          privateKey: wallet.privateKey, publicKey: wallet.publicKey,
        });

      expect(broadcastTxSpy._callCount).toBe(1);
      expect(broadcastSpy._callCount).toBe(1);
    });
  });

  // ============================================================
  // GET /balance/:address
  // ============================================================
  describe('GET /balance/:address', () => {
    it('返回 200 并包含余额信息', async () => {
      const res = await request(app).get('/balance/some_address');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.address).toBe('some_address');
      expect(res.body.balance).toBe(100);
      expect(res.body.totalBalance).toBe(100);
      expect(res.body.lockedRewards).toBe(0);
      expect(res.body.coinbaseMaturity).toBe(100);
    });

    it('pendingTransactions 反映交易池中与地址相关的交易数', async () => {
      starCoin.pendingTransactions = [
        { from: 'addr_a', to: 'addr_b' },
        { from: 'addr_a', to: 'addr_c' },
      ];
      const res = await request(app).get('/balance/addr_a');
      expect(res.body.pendingTransactions).toBe(2);
    });

    it('historyCount 调用 getTransactionHistory', async () => {
      starCoin.getTransactionHistory = (addr) => {
        expect(addr).toBe('my_addr');
        return [{ id: 'tx1' }, { id: 'tx2' }];
      };
      const res = await request(app).get('/balance/my_addr');
      expect(res.body.historyCount).toBe(2);
    });
  });

  // ============================================================
  // GET /transactions/:address
  // ============================================================
  describe('GET /transactions/:address', () => {
    it('返回 200 并包含交易历史', async () => {
      starCoin.getTransactionHistory = (addr) => {
        expect(addr).toBe('test_addr');
        return [{ id: 'tx1', amount: 10 }];
      };
      const res = await request(app).get('/transactions/test_addr');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.address).toBe('test_addr');
      expect(res.body.total).toBe(1);
      expect(res.body.transactions).toEqual([{ id: 'tx1', amount: 10 }]);
    });

    it('地址无交易时返回空数组', async () => {
      const res = await request(app).get('/transactions/empty_addr');
      expect(res.body.total).toBe(0);
      expect(res.body.transactions).toEqual([]);
    });
  });

  // ============================================================
  // GET /mempool
  // ============================================================
  describe('GET /mempool', () => {
    it('空交易池返回 count = 0', async () => {
      const res = await request(app).get('/mempool');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.count).toBe(0);
      expect(res.body.transactions).toEqual([]);
    });

    it('有交易时返回交易列表', async () => {
      starCoin.pendingTransactions = [{ id: 'tx1' }, { id: 'tx2' }];
      const res = await request(app).get('/mempool');
      expect(res.body.count).toBe(2);
      expect(res.body.transactions.length).toBe(2);
    });
  });

  // ============================================================
  // DELETE /mempool
  // ============================================================
  describe('DELETE /mempool', () => {
    it('清空交易池并返回被清除的数量', async () => {
      starCoin.pendingTransactions = [{ id: 'tx1' }, { id: 'tx2' }, { id: 'tx3' }];
      const res = await request(app).delete('/mempool');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.cleared).toBe(3);
      expect(res.body.message).toContain('3');
    });

    it('空交易池返回 cleared = 0', async () => {
      const res = await request(app).delete('/mempool');
      expect(res.body.cleared).toBe(0);
    });
  });

  // ============================================================
  // GET /addresses
  // ============================================================
  describe('GET /addresses', () => {
    it('返回所有地址列表', async () => {
      const res = await request(app).get('/addresses');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.total).toBe(2);
      expect(res.body.addresses).toEqual(['addr1', 'addr2']);
    });
  });
});