// ============================================================
// p2p-discovery.test.js
// 覆盖: createDiscoveryModule 的纯逻辑方法
// 测试策略: 用 Mock core 隔离 WebSocket 依赖，验证发现逻辑
// ============================================================
const { createDiscoveryModule } = require('../src/p2p/p2p-discovery');
const { MESSAGE_TYPES } = require('../src/p2p/p2p-core');

/**
 * 创建一个 mock core 对象（模拟 p2p-core.js 返回的网络核心）
 */
function createMockCore() {
  return {
    nodeInfo: {
      id: 'test-node',
      url: 'ws://localhost:3000',
      port: 3000
    },
    nodes: new Set(),
    nodeConnections: new Map(),
    wss: {
      clients: new Set()
    },
    sendMessage: vi.fn(),
    broadcast: vi.fn(),
    reconnect: {
      init: vi.fn(),
      schedule: vi.fn(),
      clear: vi.fn(),
      has: vi.fn(() => false),
      getState: vi.fn(() => new Map())
    },
    heartbeat: {
      start: vi.fn(),
      stop: vi.fn()
    },
    getHandler: vi.fn(() => null)
  };
}

describe('p2p-discovery — 自动节点发现', () => {
  let core, discovery;

  beforeEach(() => {
    core = createMockCore();
    discovery = createDiscoveryModule(core, MESSAGE_TYPES);
  });

  // ============================================================
  // handleDiscoveredNodes
  // ============================================================
  describe('handleDiscoveredNodes — 处理发现的节点', () => {
    it('空数组不添加任何节点', () => {
      discovery.handleDiscoveredNodes([], 'node1');
      const status = discovery.getDiscoveryStatus();
      expect(status.pendingCount).toBe(0);
    });

    it('无效输入不报错', () => {
      expect(() => {
        discovery.handleDiscoveredNodes(null, 'node1');
        discovery.handleDiscoveredNodes(undefined, 'node1');
      }).not.toThrow();
    });

    it('添加新节点到待连接队列', () => {
      discovery.handleDiscoveredNodes(['ws://localhost:3001'], 'node1');
      const status = discovery.getDiscoveryStatus();
      expect(status.pendingCount).toBe(1);
      expect(status.pendingNodes).toContain('ws://localhost:3001');
    });

    it('跳过自身节点', () => {
      discovery.handleDiscoveredNodes(['ws://localhost:3000'], 'node1');
      const status = discovery.getDiscoveryStatus();
      expect(status.pendingCount).toBe(0);
    });

    it('跳过已连接节点', () => {
      core.nodes.add('ws://localhost:3001');
      discovery.handleDiscoveredNodes(['ws://localhost:3001'], 'node1');
      const status = discovery.getDiscoveryStatus();
      expect(status.pendingCount).toBe(0);
    });

    it('跳过重复添加', () => {
      discovery.handleDiscoveredNodes(['ws://localhost:3001', 'ws://localhost:3001'], 'node1');
      const status = discovery.getDiscoveryStatus();
      expect(status.pendingCount).toBe(1);
    });

    it('多个新节点全部加入队列', () => {
      discovery.handleDiscoveredNodes(
        ['ws://localhost:3001', 'ws://localhost:3002', 'ws://localhost:3003'],
        'node1'
      );
      const status = discovery.getDiscoveryStatus();
      expect(status.pendingCount).toBe(3);
    });
  });

  // ============================================================
  // tryConnectPendingNodes
  // ============================================================
  describe('tryConnectPendingNodes — 尝试连接待连接节点', () => {
    it('队列为空时不做任何操作', () => {
      discovery.tryConnectPendingNodes();
      const status = discovery.getDiscoveryStatus();
      expect(status.connectingCount).toBe(0);
    });

    it('达到最大连接数后清空队列', () => {
      // 最大默认是 20，先加满
      for (let i = 0; i < 20; i++) {
        core.nodes.add(`ws://localhost:${3000 + i}`);
      }
      // 添加 5 个待连接
      discovery.handleDiscoveredNodes(
        ['ws://localhost:4001', 'ws://localhost:4002'],
        'node1'
      );
      discovery.tryConnectPendingNodes();
      const status = discovery.getDiscoveryStatus();
      expect(status.pendingCount).toBe(0);
    });

    it('每轮最多连接 maxConnectPerRound 个节点', () => {
      // 已有 18 个连接
      for (let i = 0; i < 18; i++) {
        core.nodes.add(`ws://localhost:${3000 + i}`);
      }
      // 添加 10 个待连接
      const urls = Array.from({ length: 10 }, (_, i) => `ws://localhost:${5000 + i}`);
      discovery.handleDiscoveredNodes(urls, 'node1');

      discovery.tryConnectPendingNodes();
      // maxConnectPerRound = 3, maxPeers = 20, 剩余 2 个名额 → 只连 2 个
      const status = discovery.getDiscoveryStatus();
      expect(status.connectingCount).toBe(2);
      expect(status.pendingCount).toBe(8); // 10 - 2 = 8 个剩余
    });
  });

  // ============================================================
  // startDiscovery / stopDiscovery
  // ============================================================
  describe('startDiscovery / stopDiscovery — 定时器管理', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('startDiscovery 设置定时器并标记启用', () => {
      discovery.startDiscovery();
      const status = discovery.getDiscoveryStatus();
      expect(status.enabled).toBe(true);
    });

    it('stopDiscovery 清除定时器并标记禁用', () => {
      discovery.startDiscovery();
      discovery.stopDiscovery();
      const status = discovery.getDiscoveryStatus();
      expect(status.enabled).toBe(false);
    });

    it('重复 startDiscovery 不会设置多个定时器', () => {
      discovery.startDiscovery();
      discovery.startDiscovery(); // 第二次应被忽略
      // 验证不会报错
      const status = discovery.getDiscoveryStatus();
      expect(status.enabled).toBe(true);
    });

    it('停止后 startDiscovery 可再次启动', () => {
      discovery.startDiscovery();
      discovery.stopDiscovery();
      discovery.startDiscovery();
      const status = discovery.getDiscoveryStatus();
      expect(status.enabled).toBe(true);
    });
  });

  // ============================================================
  // getDiscoveryStatus
  // ============================================================
  describe('getDiscoveryStatus — 状态查询', () => {
    it('返回默认状态', () => {
      const status = discovery.getDiscoveryStatus();
      expect(status).toMatchObject({
        enabled: true,
        interval: 30000,
        maxPeers: 20,
        pendingCount: 0,
        connectingCount: 0,
        connectedCount: 0,
        isDiscovering: false
      });
      expect(Array.isArray(status.pendingNodes)).toBe(true);
      expect(Array.isArray(status.connectingNodes)).toBe(true);
    });

    it('反映当前队列状态', () => {
      discovery.handleDiscoveredNodes(['ws://localhost:3001'], 'node1');
      const status = discovery.getDiscoveryStatus();
      expect(status.pendingCount).toBe(1);
      expect(status.pendingNodes).toContain('ws://localhost:3001');
    });
  });

  // ============================================================
  // requestNodeLists — 请求节点列表（需要 connected nodes）
  // ============================================================
  describe('requestNodeLists — 请求节点列表', () => {
    it('无已连接节点时返回', () => {
      // 没有连接的节点，requestNodeLists 应该早期返回
      discovery.requestNodeLists();
      expect(core.sendMessage).not.toHaveBeenCalled();
    });

    it('有已连接节点时发送请求', () => {
      // 添加一个节点连接到 nodeConnections
      const mockWs = { readyState: 1 }; // WebSocket.OPEN
      core.nodeConnections.set('conn_1', { ws: mockWs, url: 'ws://localhost:3001' });

      discovery.requestNodeLists();
      expect(core.sendMessage).toHaveBeenCalled();
      const call = core.sendMessage.mock.calls[0];
      expect(call[1]).toMatchObject({
        type: 'NODE_LIST_REQUEST',
        fromNode: 'ws://localhost:3000'
      });
    });
  });
});