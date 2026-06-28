const WebSocket = require('ws');
const config = require('../config');

/**
 * 创建 P2P 自动节点发现模块
 *
 * 职责：
 * - 管理待连接节点队列（pendingNodes/connectingNodes）
 * - 周期性向已连接节点请求节点列表
 * - 自动连接发现的节点（含重连 + 心跳保活）
 * - 不依赖区块链业务逻辑（starCoin），只依赖网络基础设施 core
 *
 * @param {object} core - p2p-core.js 返回的网络核心对象（含 sendMessage、wss、nodes、reconnect、heartbeat 等）
 * @param {object} MESSAGE_TYPES - 消息类型常量
 */
function createDiscoveryModule(core, MESSAGE_TYPES) {

    // ========== 发现状态 ==========
    const pendingNodes = new Set();      // 待连接节点队列（去重）
    const connectingNodes = new Set();   // 正在连接中的节点 URL
    const discoveryConfig = {
        interval: config.P2P_DISCOVERY_INTERVAL,
        maxPeers: config.P2P_DISCOVERY_MAX_PEERS,
        maxConnectPerRound: config.P2P_DISCOVERY_MAX_PER_ROUND,
        enabled: true
    };
    let discoveryTimer = null;           // 定时器句柄
    let isDiscovering = false;           // 是否正在发现中

    // ========== 节点发现逻辑 ==========

    /**
     * 处理从其他节点发现的节点 URL，加入待连接队列
     * @param {string[]} discoveredNodes - 发现的节点 URL 数组
     * @param {string} [fromNode] - 来源节点标识
     */
    function handleDiscoveredNodes(discoveredNodes, fromNode) {
        if (!Array.isArray(discoveredNodes) || discoveredNodes.length === 0) return;

        let newCount = 0;
        for (const nodeUrl of discoveredNodes) {
            // 跳过自身、已连接、正在连接、已在队列中的节点
            if (nodeUrl === core.nodeInfo.url) continue;
            if (core.nodes.has(nodeUrl)) continue;
            if (connectingNodes.has(nodeUrl)) continue;
            if (pendingNodes.has(nodeUrl)) continue;

            pendingNodes.add(nodeUrl);
            newCount++;
        }

        if (newCount > 0) {
            console.log(`🔍 从 ${fromNode || '某节点'} 发现 ${newCount} 个新节点，待连接队列: ${pendingNodes.size}`);
        }
    }

    /**
     * 向所有已连接节点广播节点列表请求
     */
    function requestNodeLists() {
        if (isDiscovering) return;
        if (!discoveryConfig.enabled) return;

        const connectedCount = core.nodeConnections.size +
            Array.from(core.wss.clients).filter(c => c.readyState === WebSocket.OPEN).length;

        if (connectedCount === 0) {
            return;
        }

        isDiscovering = true;
        console.log(`🔍 [发现] 正在向 ${connectedCount} 个已连接节点请求节点列表...`);

        const requestMsg = {
            type: MESSAGE_TYPES.NODE_LIST_REQUEST,
            fromNode: core.nodeInfo.url
        };

        core.wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                core.sendMessage(client, requestMsg);
            }
        });
        core.nodeConnections.forEach((conn) => {
            if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
                core.sendMessage(conn.ws, requestMsg);
            }
        });

        // 给节点一些时间响应，然后尝试连接待连接节点
        setTimeout(() => {
            tryConnectPendingNodes();
            isDiscovering = false;
        }, 5000);
    }

    /**
     * 尝试连接待连接队列中的节点（按配置限额）
     */
    function tryConnectPendingNodes() {
        if (pendingNodes.size === 0) return;
        if (!discoveryConfig.enabled) return;

        const currentPeers = core.nodes.size;
        if (currentPeers >= discoveryConfig.maxPeers) {
            console.log(`🔍 [发现] 已达到最大连接数 (${discoveryConfig.maxPeers})，清空待连接队列`);
            pendingNodes.clear();
            return;
        }

        const canConnect = Math.min(
            discoveryConfig.maxConnectPerRound,
            discoveryConfig.maxPeers - currentPeers,
            pendingNodes.size
        );

        if (canConnect === 0) return;
        console.log(`🔍 [发现] 正在尝试连接 ${canConnect}/${pendingNodes.size} 个待连接节点...`);

        const toConnect = [];
        for (const nodeUrl of pendingNodes) {
            if (toConnect.length >= canConnect) break;
            pendingNodes.delete(nodeUrl);
            connectingNodes.add(nodeUrl);
            toConnect.push(nodeUrl);
        }

        for (const nodeUrl of toConnect) {
            _autoConnect(nodeUrl);
        }
    }

    /**
     * 自动连接单个节点
     * - 与 core.connectToPeer 逻辑类似，但额外管理 connectingNodes 状态
     * - 带自动重连 + 心跳保活
     * @param {string} nodeUrl - 节点 WebSocket URL
     */
    function _autoConnect(nodeUrl) {
        if (core.nodes.has(nodeUrl) || nodeUrl === core.nodeInfo.url) {
            connectingNodes.delete(nodeUrl);
            return;
        }

        // 初始化重连状态
        core.reconnect.init(nodeUrl);

        const ws = (core.createWebSocket ? core.createWebSocket(nodeUrl) : new WebSocket(nodeUrl));
        const connectionId = `auto_${Math.random().toString(36).substr(2, 9)}`;

        ws.on('open', () => {
            console.log(`🔗 [自动发现] 已连接到: ${nodeUrl}`);
            core.nodes.add(nodeUrl);
            connectingNodes.delete(nodeUrl);

            // 连接成功 → 清除重连状态
            core.reconnect.clear(nodeUrl);

            core.sendMessage(ws, {
                type: MESSAGE_TYPES.NODE_INFO,
                node: core.nodeInfo
            });
            // 连接后立即请求对方的节点列表
            core.sendMessage(ws, {
                type: MESSAGE_TYPES.NODE_LIST_REQUEST,
                fromNode: core.nodeInfo.url
            });
            core.sendMessage(ws, {
                type: MESSAGE_TYPES.QUERY_LATEST
            });
            // 连接后立即请求对方的待打包交易
            core.sendMessage(ws, {
                type: MESSAGE_TYPES.QUERY_PENDING_TXS,
                fromNode: core.nodeInfo.url
            });

            core.nodeConnections.set(connectionId, { ws, id: connectionId, url: nodeUrl });

            // 启动心跳保活
            core.heartbeat.start(ws, nodeUrl, connectionId);
        });

        ws.on('message', (message) => {
            // 通过 core.getHandler() 获取由 p2p.js 注册的消息处理器
            const handler = core.getHandler();
            if (handler) {
                handler(ws, JSON.parse(message), connectionId);
            }
        });

        ws.on('close', () => {
            console.log(`🔌 [自动发现] 连接已关闭: ${nodeUrl}`);
            core.heartbeat.stop(connectionId);
            core.nodes.delete(nodeUrl);
            core.nodeConnections.delete(connectionId);
            connectingNodes.delete(nodeUrl);

            // 自动重连
            if (core.reconnect.has(nodeUrl)) {
                core.reconnect.schedule(nodeUrl, (url) => _autoConnect(url));
            }
        });

        ws.on('error', (error) => {
            console.error(`❌ [自动发现] 连接失败: ${nodeUrl}`, error.message || error);
            core.heartbeat.stop(connectionId);
            core.nodes.delete(nodeUrl);
            core.nodeConnections.delete(connectionId);
            connectingNodes.delete(nodeUrl);

            // 连接失败也触发重连
            if (core.reconnect.has(nodeUrl)) {
                core.reconnect.schedule(nodeUrl, (url) => _autoConnect(url));
            }
        });
    }

    // ========== 定时器管理 ==========

    /**
     * 启动自动发现定时器（周期性请求节点列表）
     */
    function startDiscovery() {
        if (discoveryTimer) return;
        discoveryConfig.enabled = true;
        console.log(`🔍 [自动发现] 已启动（间隔: ${discoveryConfig.interval / 1000}秒, 最大节点数: ${discoveryConfig.maxPeers}）`);
        discoveryTimer = setInterval(() => {
            requestNodeLists();
        }, discoveryConfig.interval);
    }

    /**
     * 停止自动发现定时器
     */
    function stopDiscovery() {
        if (discoveryTimer) {
            clearInterval(discoveryTimer);
            discoveryTimer = null;
        }
        discoveryConfig.enabled = false;
        console.log('🔍 [自动发现] 已停止');
    }

    /**
     * 获取自动发现状态
     */
    function getDiscoveryStatus() {
        return {
            enabled: discoveryConfig.enabled,
            interval: discoveryConfig.interval,
            maxPeers: discoveryConfig.maxPeers,
            connectedCount: core.nodes.size,
            pendingCount: pendingNodes.size,
            connectingCount: connectingNodes.size,
            isDiscovering: isDiscovering,
            pendingNodes: Array.from(pendingNodes),
            connectingNodes: Array.from(connectingNodes)
        };
    }

    // ========== 返回发现的 API ==========

    return {
        // 核心发现方法
        handleDiscoveredNodes,
        requestNodeLists,
        tryConnectPendingNodes,

        // 定时器管理
        startDiscovery,
        stopDiscovery,

        // 状态查询
        getDiscoveryStatus,

        // 状态引用（供上层读取当前队列状态）
        getStats: () => ({
            pendingCount: pendingNodes.size,
            connectingCount: connectingNodes.size,
            isDiscovering
        })
    };
}

module.exports = { createDiscoveryModule };