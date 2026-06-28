// ============================================================
// p2p-message-handlers.test.js
// 覆盖: createMessageHandlers 的所有公开方法
// 测试策略: 纯依赖注入，所有依赖用 Mock，无需真实 WebSocket
// ============================================================

const { createMessageHandlers } = require('../src/p2p/p2p-message-handlers');

describe('p2p-message-handlers', () => {
  let mockNetwork, mockStarCoin, handlers;

  beforeEach(() => {
    mockNetwork = {
      sendMessage: vi.fn(),
      broadcast: vi.fn(),
      nodeInfo: {
        id: 'test-node',
        url: 'ws://localhost:3000',
        chainLength: 1
      },
      nodes: new Set(),
      pendingPongs: new Map()
    };

    mockStarCoin = {
      chain: [
        { index: 0, hash: '0'.repeat(64), previousHash: '0'.repeat(64), transactions: [] }
      ],
      pendingTransactions: [],
      getLatestBlock() {
        return this.chain[this.chain.length - 1];
      },
      addBlock(block) {
        const latest = this.getLatestBlock();
        if (latest.hash === block.previousHash) {
          this.chain.push(block);
          return true;
        }
        return false;
      },
      replaceChain(chain) {
        if (chain && chain.length > 0) {
          this.chain = [...chain];
          return true;
        }
        return false;
      },
      isChainValid() { return true; },
      repairChain() { return []; }
    };

    handlers = createMessageHandlers(mockNetwork, mockStarCoin);
  });

  // ============================================================
  // handleMessage — 消息路由分发
  // ============================================================
  describe('handleMessage — 消息路由', () => {
    it('QUERY_LATEST → 发送最新区块', () => {
      const ws = {};
      handlers.handleMessage(ws, { type: 'QUERY_LATEST' });
      expect(mockNetwork.sendMessage).toHaveBeenCalledWith(ws, {
        type: 'BLOCK',
        block: mockStarCoin.getLatestBlock()
      });
    });

    it('QUERY_ALL → 发送完整链', () => {
      const ws = {};
      handlers.handleMessage(ws, { type: 'QUERY_ALL' });
      expect(mockNetwork.sendMessage).toHaveBeenCalledWith(ws, {
        type: 'CHAIN',
        chain: mockStarCoin.chain
      });
    });

    it('CHAIN → 通过消息路由调用 handleChainResponse（链增长）', () => {
      const newBlock = { index: 1, hash: 'a'.repeat(64), previousHash: '0'.repeat(64) };
      handlers.handleMessage({}, { type: 'CHAIN', chain: [newBlock], fromNode: 'node1' });
      // verify addBlock was called (chain grew)
      expect(mockStarCoin.chain.length).toBe(2);
    });

    it('BLOCK → 通过消息路由调用 handleBlockResponse（区块追加）', () => {
      const block = { index: 1, hash: 'a'.repeat(64), previousHash: '0'.repeat(64) };
      handlers.handleMessage({}, { type: 'BLOCK', block });
      // verify block was added and broadcast
      expect(mockStarCoin.chain.length).toBe(2);
      expect(mockNetwork.broadcast).toHaveBeenCalled();
    });

    it('NODE_INFO → 通过消息路由调用 handleNodeInfo（节点添加）', () => {
      const node = { url: 'ws://localhost:3001' };
      handlers.handleMessage({}, { type: 'NODE_INFO', node });
      expect(mockNetwork.nodes.has('ws://localhost:3001')).toBe(true);
    });

    it('CHAIN_LENGTH → 发送链长度信息', () => {
      const ws = {};
      handlers.handleMessage(ws, { type: 'CHAIN_LENGTH' });
      expect(mockNetwork.sendMessage).toHaveBeenCalledWith(ws, {
        type: 'CHAIN_LENGTH',
        length: mockStarCoin.chain.length,
        latestHash: mockStarCoin.getLatestBlock().hash,
        fromNode: 'ws://localhost:3000'
      });
    });

    it('SYNC_REQUEST → 发送完整链', () => {
      const ws = {};
      handlers.handleMessage(ws, { type: 'SYNC_REQUEST', fromNode: 'node1' });
      expect(mockNetwork.sendMessage).toHaveBeenCalledWith(ws, {
        type: 'CHAIN',
        chain: mockStarCoin.chain,
        fromNode: 'ws://localhost:3000'
      });
    });

    it('PING → 回复 PONG', () => {
      const ws = {};
      handlers.handleMessage(ws, { type: 'PING' });
      expect(mockNetwork.sendMessage).toHaveBeenCalledWith(ws, { type: 'PONG' });
    });

    it('PONG → 清除 pendingPong 超时', () => {
      const timeoutId = setTimeout(() => { }, 10000);
      mockNetwork.pendingPongs.set('conn_123', timeoutId);
      handlers.handleMessage({}, { type: 'PONG' }, 'conn_123');
      expect(mockNetwork.pendingPongs.has('conn_123')).toBe(false);
    });

    it('PONG → 无 connectionId 时不报错', () => {
      expect(() => {
        handlers.handleMessage({}, { type: 'PONG' });
      }).not.toThrow();
    });

    it('TRANSACTION → 通过消息路由分派，不抛异常', () => {
      expect(() => {
        handlers.handleMessage({}, { type: 'TRANSACTION', transaction: { id: 'tx1' }, fromNode: 'node1' });
      }).not.toThrow();
    });

    it('QUERY_PENDING_TXS → 通过消息路由分派，不抛异常', () => {
      expect(() => {
        handlers.handleMessage({}, { type: 'QUERY_PENDING_TXS', fromNode: 'node1' });
      }).not.toThrow();
    });

    it('PENDING_TXS → 通过消息路由分派，不抛异常', () => {
      expect(() => {
        handlers.handleMessage({}, { type: 'PENDING_TXS', transactions: [{ id: 'tx1' }], fromNode: 'node1' });
      }).not.toThrow();
    });

    it('未知类型静默忽略，不抛异常', () => {
      expect(() => {
        handlers.handleMessage({}, { type: 'UNKNOWN_TYPE' });
      }).not.toThrow();
    });
  });

  // ============================================================
  // handleChainResponse — 链对比与同步
  // ============================================================
  describe('handleChainResponse — 链同步逻辑', () => {
    it('空链不做任何操作', () => {
      handlers.handleChainResponse([], 'node1');
      expect(mockStarCoin.chain.length).toBe(1);
      expect(mockNetwork.broadcast).not.toHaveBeenCalled();
    });

    it('收到更短的链忽略', () => {
      mockStarCoin.chain.push(
        { index: 1, hash: 'a'.repeat(64), previousHash: '0'.repeat(64) }
      );
      handlers.handleChainResponse([
        { index: 0, hash: '0'.repeat(64), previousHash: '0'.repeat(64) }
      ], 'node1');
      expect(mockStarCoin.chain.length).toBe(2);
    });

    it('收到连续链 → 调用 addBlock', () => {
      const newBlock = {
        index: 1, hash: 'a'.repeat(64), previousHash: '0'.repeat(64)
      };
      handlers.handleChainResponse([newBlock], 'node1');
      expect(mockStarCoin.chain.length).toBe(2);
      expect(mockNetwork.broadcast).toHaveBeenCalledWith({
        type: 'BLOCK',
        block: mockStarCoin.getLatestBlock()
      });
    });

    it('收到分叉链且更长 → 调用 replaceChain', () => {
      const forkChain = [
        { index: 0, hash: '0'.repeat(64), previousHash: '0'.repeat(64) },
        { index: 1, hash: 'x'.repeat(64), previousHash: '0'.repeat(64) },
        { index: 2, hash: 'y'.repeat(64), previousHash: 'x'.repeat(64) }
      ];
      handlers.handleChainResponse(forkChain, 'node1');
      expect(mockStarCoin.chain.length).toBe(3);
      expect(mockNetwork.broadcast).toHaveBeenCalled();
    });

    it('收到分叉链但 chain 无效 → 拒绝替换', () => {
      mockStarCoin.isChainValid = vi.fn(() => false);
      const forkChain = [
        { index: 0, hash: '0'.repeat(64), previousHash: '0'.repeat(64) },
        { index: 1, hash: 'x'.repeat(64), previousHash: 'wrong'.repeat(64) },
        { index: 2, hash: 'y'.repeat(64), previousHash: 'x'.repeat(64) }
      ];
      handlers.handleChainResponse(forkChain, 'node1');
      expect(mockStarCoin.chain.length).toBe(1);
    });

    it('收到单区块链（创世区块）不替换', () => {
      const genesis = { index: 0, hash: 'new'.repeat(64), previousHash: '0'.repeat(64) };
      handlers.handleChainResponse([genesis], 'node1');
      expect(mockStarCoin.chain.length).toBe(1);
    });
  });

  // ============================================================
  // handleBlockResponse — 区块添加逻辑
  // ============================================================
  describe('handleBlockResponse — 区块处理', () => {
    it('区块索引 <= 最新索引时忽略', () => {
      const block = { index: 0, hash: 'x'.repeat(64), previousHash: '0'.repeat(64) };
      handlers.handleBlockResponse(block);
      expect(mockStarCoin.chain.length).toBe(1);
    });

    it('区块连续 → 调用 addBlock', () => {
      const block = { index: 1, hash: 'a'.repeat(64), previousHash: '0'.repeat(64) };
      handlers.handleBlockResponse(block);
      expect(mockStarCoin.chain.length).toBe(2);
      expect(mockNetwork.broadcast).toHaveBeenCalled();
    });

    it('区块不连续 → 发送 QUERY_ALL', () => {
      const block = { index: 1, hash: 'x'.repeat(64), previousHash: 'nonexistent'.repeat(8) };
      handlers.handleBlockResponse(block);
      expect(mockNetwork.broadcast).toHaveBeenCalledWith({ type: 'QUERY_ALL' });
    });
  });

  // ============================================================
  // handleNodeInfo — 节点信息处理
  // ============================================================
  describe('handleNodeInfo — 节点发现', () => {
    it('新节点加入 nodes 集合', () => {
      handlers.handleNodeInfo({ url: 'ws://localhost:3001' });
      expect(mockNetwork.nodes.has('ws://localhost:3001')).toBe(true);
    });

    it('自身节点不加入', () => {
      handlers.handleNodeInfo({ url: 'ws://localhost:3000' });
      expect(mockNetwork.nodes.has('ws://localhost:3000')).toBe(false);
    });

    it('重复节点不重复添加（Set 自动去重）', () => {
      handlers.handleNodeInfo({ url: 'ws://localhost:3001' });
      handlers.handleNodeInfo({ url: 'ws://localhost:3001' });
      expect(mockNetwork.nodes.size).toBe(1);
    });
  });

  // ============================================================
  // broadcast 系列方法
  // ============================================================
  describe('broadcast 系列方法', () => {
    it('broadcastLatest 广播最新区块', () => {
      handlers.broadcastLatest();
      expect(mockNetwork.broadcast).toHaveBeenCalledWith({
        type: 'BLOCK',
        block: mockStarCoin.getLatestBlock()
      });
    });

    it('broadcastQueryAll 广播查询请求', () => {
      handlers.broadcastQueryAll();
      expect(mockNetwork.broadcast).toHaveBeenCalledWith({ type: 'QUERY_ALL' });
    });

    it('broadcastNodeInfo 广播节点信息', () => {
      handlers.broadcastNodeInfo();
      expect(mockNetwork.broadcast).toHaveBeenCalledWith({
        type: 'NODE_INFO',
        node: mockNetwork.nodeInfo
      });
    });

    it('broadcastTransaction 广播交易', () => {
      const tx = { id: 'tx1', from: 'A', to: 'B', amount: 10 };
      handlers.broadcastTransaction(tx);
      expect(mockNetwork.broadcast).toHaveBeenCalledWith({
        type: 'TRANSACTION',
        transaction: tx,
        fromNode: 'ws://localhost:3000'
      });
    });

    it('broadcastPendingTxs 广播待打包交易列表', () => {
      mockStarCoin.pendingTransactions = [{ id: 'tx1' }, { id: 'tx2' }];
      handlers.broadcastPendingTxs();
      expect(mockNetwork.broadcast).toHaveBeenCalledWith({
        type: 'PENDING_TXS',
        transactions: [{ id: 'tx1' }, { id: 'tx2' }],
        fromNode: 'ws://localhost:3000'
      });
    });
  });

  // ============================================================
  // updateNodeInfo
  // ============================================================
  describe('updateNodeInfo', () => {
    it('更新 chainLength 和时间戳', () => {
      mockStarCoin.chain.length = 5;
      handlers.updateNodeInfo();
      expect(mockNetwork.nodeInfo.chainLength).toBe(5);
      expect(mockNetwork.nodeInfo.lastUpdated).toBeDefined();
    });
  });

  // ============================================================
  // handleTransaction / handlePendingTxs — 桩方法（不抛出）
  // ============================================================
  describe('交易池桩方法', () => {
    it('handleTransaction 不抛出', () => {
      expect(() => {
        handlers.handleTransaction({ id: 'tx1' }, 'node1');
      }).not.toThrow();
    });

    it('handlePendingTxs 不抛出', () => {
      expect(() => {
        handlers.handlePendingTxs([{ id: 'tx1' }], 'node1');
      }).not.toThrow();
    });

    it('handlePendingTxs 对空数组不抛出', () => {
      expect(() => {
        handlers.handlePendingTxs([], 'node1');
      }).not.toThrow();
    });
  });
});