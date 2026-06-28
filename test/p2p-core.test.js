// ============================================================
// p2p-core.test.js
// 覆盖: createP2PCore 的核心方法
// 测试策略: 使用真实 HTTP Server + WebSocket，验证网络交互
// ============================================================
const http = require('http');
const WebSocket = require('ws');
const { createP2PCore, MESSAGE_TYPES } = require('../src/p2p/p2p-core');

/**
 * 创建一个 mock starCoin 实例（最小依赖）
 */
function createMinimalStarCoin() {
  return {
    chain: [{ index: 0, hash: '0'.repeat(64), previousHash: '0'.repeat(64) }],
    pendingTransactions: [],
    getLatestBlock() { return this.chain[this.chain.length - 1]; },
    addBlock(block) { this.chain.push(block); return true; },
    replaceChain(chain) { this.chain = [...chain]; return true; },
    isChainValid() { return true; },
    repairChain() { return []; }
  };
}

/**
 * 等待指定毫秒
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 安全关闭 HTTP Server（超时保护）
 */
function closeServer(server) {
  return new Promise(resolve => {
    server.close(() => resolve());
    // 超时保护：最多等 3 秒
    setTimeout(() => resolve(), 3000);
  });
}

describe('p2p-core — 核心网络层', () => {
  let server, port, starCoin, core;

  beforeEach(async () => {
    server = http.createServer();
    await new Promise(resolve => server.listen(0, resolve));
    port = server.address().port;
    starCoin = createMinimalStarCoin();
    core = createP2PCore(server, starCoin, port);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeServer(server);
  });

  // ============================================================
  // sendMessage / setHandler / getHandler
  // ============================================================
  describe('sendMessage / setHandler / getHandler', () => {
    it('sendMessage 发送 JSON 字符串到 OPEN 状态连接', () => {
      const ws = { readyState: WebSocket.OPEN, send: vi.fn() };
      core.sendMessage(ws, { type: 'TEST', data: 'hello' });
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'TEST', data: 'hello' }));
    });

    it('sendMessage 跳过非 OPEN 连接', () => {
      const ws = { readyState: WebSocket.CLOSED, send: vi.fn() };
      core.sendMessage(ws, { type: 'TEST' });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('setHandler/getHandler 存取消息处理函数', () => {
      const handler = vi.fn();
      core.setHandler(handler);
      expect(core.getHandler()).toBe(handler);
    });

    it('setHandler 可覆盖已有处理器', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      core.setHandler(h1);
      core.setHandler(h2);
      expect(core.getHandler()).toBe(h2);
    });
  });

  // ============================================================
  // 重连管理器
  // ============================================================
  describe('重连管理器 reconnect', () => {
    it('init 初始化重连状态', () => {
      core.reconnect.init('ws://localhost:3001');
      expect(core.reconnect.has('ws://localhost:3001')).toBe(true);
    });

    it('clear 清除重连状态', () => {
      core.reconnect.init('ws://localhost:3001');
      core.reconnect.clear('ws://localhost:3001');
      expect(core.reconnect.has('ws://localhost:3001')).toBe(false);
    });

    it('clear 清除未调度的连接不报错', () => {
      expect(() => {
        core.reconnect.clear('ws://nonexistent');
      }).not.toThrow();
    });

    it('schedule 在指定延迟后调用连接函数', () => {
      vi.useFakeTimers();
      const connectFn = vi.fn();
      core.reconnect.init('ws://localhost:3001');
      core.reconnect.schedule('ws://localhost:3001', connectFn);

      vi.advanceTimersByTime(5000);
      expect(connectFn).toHaveBeenCalledWith('ws://localhost:3001');

      vi.useRealTimers();
    });

    it('getState 返回状态副本', () => {
      core.reconnect.init('ws://localhost:3001');
      const state = core.reconnect.getState();
      expect(state.has('ws://localhost:3001')).toBe(true);
      // 修改副本不影响原始状态
      state.delete('ws://localhost:3001');
      expect(core.reconnect.has('ws://localhost:3001')).toBe(true);
    });
  });

  // ============================================================
  // 心跳管理器
  // ============================================================
  describe('心跳管理器 heartbeat', () => {
    it('start 不抛出异常', () => {
      const ws = { readyState: WebSocket.OPEN, send: vi.fn() };
      expect(() => {
        core.heartbeat.start(ws, 'ws://localhost:3001', 'test_conn');
      }).not.toThrow();
      core.heartbeat.stop('test_conn');
    });

    it('stop 清理定时器', () => {
      const ws = { readyState: WebSocket.OPEN, send: vi.fn() };
      core.heartbeat.start(ws, 'ws://localhost:3001', 'test_conn');
      expect(() => {
        core.heartbeat.stop('test_conn');
      }).not.toThrow();
    });

    it('stop 不存在的连接不报错', () => {
      expect(() => {
        core.heartbeat.stop('nonexistent');
      }).not.toThrow();
    });
  });

  // ============================================================
  // disconnectFromPeer
  // ============================================================
  describe('disconnectFromPeer', () => {
    it('断开未连接的节点返回失败', () => {
      const result = core.disconnectFromPeer('ws://localhost:9999');
      expect(result.success).toBe(false);
      expect(result.message).toContain('未连接');
    });

    it('断开已连接的节点返回成功', () => {
      core.nodes.add('ws://localhost:3001');
      const result = core.disconnectFromPeer('ws://localhost:3001');
      expect(result.success).toBe(true);
      expect(core.nodes.has('ws://localhost:3001')).toBe(false);
    });

    it('断开会清除重连状态', () => {
      core.nodes.add('ws://localhost:3001');
      core.reconnect.init('ws://localhost:3001');
      core.disconnectFromPeer('ws://localhost:3001');
      expect(core.reconnect.has('ws://localhost:3001')).toBe(false);
    });
  });

  // ============================================================
  // broadcast
  // ============================================================
  describe('broadcast', () => {
    it('广播消息到所有已连接客户端', () => {
      const ws1 = { readyState: WebSocket.OPEN, send: vi.fn() };
      const ws2 = { readyState: WebSocket.OPEN, send: vi.fn() };
      core.wss.clients.add(ws1);
      core.wss.clients.add(ws2);

      core.broadcast({ type: 'TEST' });

      expect(ws1.send).toHaveBeenCalledWith(JSON.stringify({ type: 'TEST' }));
      expect(ws2.send).toHaveBeenCalledWith(JSON.stringify({ type: 'TEST' }));
    });

    it('跳过非 OPEN 状态的客户端', () => {
      const ws1 = { readyState: WebSocket.OPEN, send: vi.fn() };
      const ws2 = { readyState: WebSocket.CLOSED, send: vi.fn() };
      core.wss.clients.add(ws1);
      core.wss.clients.add(ws2);

      core.broadcast({ type: 'TEST' });

      expect(ws1.send).toHaveBeenCalled();
      expect(ws2.send).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // connectToPeer — 连接到对等节点（需要真实 WebSocket 服务）
  //
  // 注意：每个测试需手动清理 WebSocket 连接，否则 server.close() 会挂起
  // ============================================================
  describe('connectToPeer — 连接到对等节点', () => {
    let peerServer, peerPort, peerCore, activeClients;

    beforeEach(async () => {
      activeClients = [];
      peerServer = http.createServer();
      await new Promise(resolve => peerServer.listen(0, resolve));
      peerPort = peerServer.address().port;
      peerCore = createP2PCore(peerServer, createMinimalStarCoin(), peerPort);
    });

    afterEach(async () => {
      // 先关闭所有 WebSocket 连接，再关服务器
      for (const client of activeClients) {
        try { client.close(); } catch (_) { /* 忽略 */ }
      }
      await sleep(50);
      await closeServer(peerServer);
    });

    it('连接到对等节点成功', async () => {
      const handler = vi.fn();
      peerCore.setHandler(handler);

      const peerUrl = `ws://localhost:${peerPort}`;
      core.connectToPeer(peerUrl, false);

      await sleep(200);

      expect(core.nodes.has(peerUrl)).toBe(true);
    });

    it('连接后自动发送 NODE_INFO', async () => {
      const handler = vi.fn();
      peerCore.setHandler(handler);

      const peerUrl = `ws://localhost:${peerPort}`;
      core.connectToPeer(peerUrl, false);

      await sleep(200);

      const nodeInfoCall = handler.mock.calls.find(
        ([ws, msg]) => msg && msg.type === 'NODE_INFO'
      );
      expect(nodeInfoCall).toBeDefined();
      expect(nodeInfoCall[1].node.url).toBe(`ws://localhost:${port}`);

      // 关闭 connectToPeer 创建的连接
      const connEntry = core.nodeConnections.get(peerUrl);
      if (connEntry && connEntry.ws) {
        activeClients.push(connEntry.ws);
      }
    });

    it('连接到不存在的节点不崩溃', () => {
      expect(() => {
        core.connectToPeer('ws://localhost:19999', false);
      }).not.toThrow();
    });

    it('不重复连接自身', () => {
      const spy = vi.spyOn(core, 'sendMessage');
      core.connectToPeer(`ws://localhost:${port}`, false);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('不重复连接已连接节点', () => {
      core.nodes.add('ws://localhost:3001');
      const spy = vi.spyOn(core, 'sendMessage');
      core.connectToPeer('ws://localhost:3001', false);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  // ============================================================
  // wss.on('connection') — 入站连接处理
  //
  // 注意：每个测试创建独立 server，避免 handleUpgrade 冲突
  // ============================================================
  describe('wss.on(connection) — 入站连接处理', () => {
    let localServer, localPort, localCore;

    beforeEach(async () => {
      localServer = http.createServer();
      await new Promise(resolve => localServer.listen(0, resolve));
      localPort = localServer.address().port;
      localCore = createP2PCore(localServer, createMinimalStarCoin(), localPort);
    });

    afterEach(async () => {
      await closeServer(localServer);
    });

    it('新节点连接后收到 CHAIN + NODE_INFO', async () => {
      const handler = vi.fn();
      localCore.setHandler(handler);

      const client = new WebSocket(`ws://localhost:${localPort}`);
      const received = [];

      client.on('message', (data) => {
        received.push(JSON.parse(data));
      });

      await sleep(100);

      expect(received.length).toBeGreaterThanOrEqual(2);
      const types = received.map(r => r.type);
      expect(types).toContain('CHAIN');
      expect(types).toContain('NODE_INFO');

      client.close();
    });

    it('入站连接的消息通过 handler 处理', async () => {
      const handler = vi.fn();
      localCore.setHandler(handler);

      const client = new WebSocket(`ws://localhost:${localPort}`);
      await sleep(50);

      client.send(JSON.stringify({ type: 'PING' }));
      await sleep(50);

      expect(handler).toHaveBeenCalled();
      const pingCall = handler.mock.calls.find(
        ([ws, msg]) => msg && msg.type === 'PING'
      );
      expect(pingCall).toBeDefined();

      client.close();
    });

    it('前端 WS 连接（/ws 路径）触发 onFrontendConnection 回调', async () => {
      const frontendHandler = vi.fn();
      const feServer = http.createServer();
      await new Promise(resolve => feServer.listen(0, resolve));
      const fePort = feServer.address().port;
      const feCore = createP2PCore(feServer, createMinimalStarCoin(), fePort, {
        onFrontendConnection: frontendHandler
      });
      feCore.setHandler(vi.fn());

      const client = new WebSocket(`ws://localhost:${fePort}/ws`);
      await sleep(100);

      expect(frontendHandler).toHaveBeenCalled();

      client.close();
      await closeServer(feServer);
    });
  });

  // ============================================================
  // getAllNodeInfo
  // ============================================================
  describe('getAllNodeInfo', () => {
    it('返回包含自身节点信息的数组', async () => {
      const result = await core.getAllNodeInfo();
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]).toMatchObject({
        isSelf: true,
        connected: true,
        url: `ws://localhost:${port}`
      });
    });
  });
});