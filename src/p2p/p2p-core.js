const WebSocket = require('ws');

// 消息类型
const MESSAGE_TYPES = {
    CHAIN: 'CHAIN',
    BLOCK: 'BLOCK',
    QUERY_LATEST: 'QUERY_LATEST',
    QUERY_ALL: 'QUERY_ALL',
    NODE_INFO: 'NODE_INFO',
    NODE_LIST: 'NODE_LIST',
    NODE_LIST_REQUEST: 'NODE_LIST_REQUEST',
    CHAIN_LENGTH: 'CHAIN_LENGTH',
    SYNC_REQUEST: 'SYNC_REQUEST',
    PING: 'PING',
    PONG: 'PONG',
    // 交易池广播相关
    TRANSACTION: 'TRANSACTION',
    QUERY_PENDING_TXS: 'QUERY_PENDING_TXS',
    PENDING_TXS: 'PENDING_TXS'
};

// ========== 重连管理器配置 ==========
const RECONNECT_BASE_DELAY = 1000;    // 初始延迟 1 秒
const RECONNECT_MAX_DELAY  = 30000;   // 最大延迟 30 秒
const RECONNECT_MAX_RETRIES = 50;     // 最大重试次数（50 次≈约 15 分钟持续重连后放弃）
const RECONNECT_JITTER = 0.3;         // 抖动 ±30%

// ========== 心跳配置 ==========
const HEARTBEAT_INTERVAL = 15000;     // 每 15 秒发送一次 PING
const HEARTBEAT_TIMEOUT  = 6000;      // 6 秒内未收到 PONG 视为超时

/**
 * 创建 P2P 核心网络层
 *
 * 职责：仅处理网络基础设施——WebSocket 服务、连接管理、重连、心跳、基础收发
 * 不包含任何区块链业务逻辑（链/区块/交易处理），这些由 p2p-message-handlers.js 负责
 *
 * 通过 setHandler(fn) 注入消息处理器，实现与业务逻辑的解耦
 *
 * @param {http.Server} server - HTTP 服务器实例
 * @param {Blockchain} starCoin - 区块链实例
 * @param {number} PORT - 当前节点端口
 * @param {object} [options] - 可选配置
 * @param {function} [options.onFrontendConnection] - 前端 WebSocket 连接回调（路径为 /ws）
 */
function createP2PCore(server, starCoin, PORT, options = {}) {
    // WebSocket 服务器
    const wss = new WebSocket.Server({ server });

    // 节点状态
    const nodes = new Set();
    const nodeConnections = new Map(); // 存储节点连接
    const nodeId = `node_${PORT}_${Math.random().toString(36).substr(2, 9)}`;

    // 节点信息
    const nodeInfo = {
        id: nodeId,
        port: PORT,
        url: `ws://localhost:${PORT}`,
        httpUrl: `http://localhost:${PORT}`,
        startedAt: new Date().toISOString(),
        chainLength: starCoin.chain.length
    };

    // ========== 消息处理器（由上层通过 setHandler 注入） ==========
    let _messageHandler = null;

    /** 注册消息处理器（由 p2p.js 或 p2p-message-handlers.js 调用） */
    function setHandler(handlerFn) {
        _messageHandler = handlerFn;
    }

    /** 获取当前消息处理器（供自动发现模块等外部 WebSocket 连接使用） */
    function getHandler() {
        return _messageHandler;
    }

    // ========== 内部工具函数 ==========

    function sendMessage(ws, message) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    }

    // ========== 重连管理器 ==========
    const reconnectState = new Map(); // url -> { attempts, timer }

    function _getReconnectDelay(attempts) {
        const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, attempts), RECONNECT_MAX_DELAY);
        // 添加随机抖动，避免多个节点同时重连造成"雷鸣群问题"
        const jitter = 1 - RECONNECT_JITTER + Math.random() * RECONNECT_JITTER * 2;
        return Math.round(delay * jitter);
    }

    /** 初始化重连状态（如果尚未初始化） */
    function _initReconnect(url) {
        if (!reconnectState.has(url)) {
            reconnectState.set(url, { attempts: 0, timer: null });
        }
    }

    /** 调度一次重连 */
    function _scheduleReconnect(url, connectFn) {
        const state = reconnectState.get(url);
        if (!state) return;

        state.attempts++;
        if (state.attempts > RECONNECT_MAX_RETRIES) {
            console.log(`🔌 [重连] ${url} 超过最大重试次数 (${RECONNECT_MAX_RETRIES})，放弃重连`);
            reconnectState.delete(url);
            return;
        }

        const delay = _getReconnectDelay(state.attempts);
        console.log(`🔌 [重连] ${url} ${(delay / 1000).toFixed(1)}s 后重试（第 ${state.attempts}/${RECONNECT_MAX_RETRIES} 次）`);

        state.timer = setTimeout(() => {
            // 检查是否还在重连状态（可能已被 clearReconnect 取消）
            if (reconnectState.has(url) && typeof connectFn === 'function') {
                connectFn(url);
            }
        }, delay);
    }

    /** 取消重连 */
    function _clearReconnect(url) {
        const state = reconnectState.get(url);
        if (state) {
            if (state.timer) clearTimeout(state.timer);
            reconnectState.delete(url);
        }
    }

    // ========== 心跳管理器 ==========
    const heartbeatIntervals = new Map(); // connectionId -> setInterval 句柄
    const pendingPongs = new Map();       // connectionId -> setTimeout 句柄

    /** 停止指定连接的心跳 */
    function _stopHeartbeat(connectionId) {
        if (heartbeatIntervals.has(connectionId)) {
            clearInterval(heartbeatIntervals.get(connectionId));
            heartbeatIntervals.delete(connectionId);
        }
        if (pendingPongs.has(connectionId)) {
            clearTimeout(pendingPongs.get(connectionId));
            pendingPongs.delete(connectionId);
        }
    }

    /** 为指定连接启动心跳（每 15s PING，6s 超时） */
    function _startHeartbeat(ws, url, connectionId) {
        _stopHeartbeat(connectionId); // 先清理旧的

        const intervalId = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) {
                _stopHeartbeat(connectionId);
                return;
            }

            // 发送 PING
            sendMessage(ws, { type: MESSAGE_TYPES.PING });

            // 设置 PONG 超时
            const timeoutId = setTimeout(() => {
                console.log(`💔 [心跳] ${url} (${connectionId}) 心跳超时，关闭连接`);
                _stopHeartbeat(connectionId);
                try { ws.close(); } catch (_) { /* 忽略关闭时的错误 */ }
                // ws.on('close') 会触发重连
            }, HEARTBEAT_TIMEOUT);

            pendingPongs.set(connectionId, timeoutId);
        }, HEARTBEAT_INTERVAL);

        heartbeatIntervals.set(connectionId, intervalId);
    }

    function broadcast(message) {
        const jsonMessage = JSON.stringify(message);
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(jsonMessage);
            }
        });
        nodeConnections.forEach((conn) => {
            if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
                conn.ws.send(jsonMessage);
            }
        });
    }

    // ========== 节点连接管理 ==========

    /**
     * 连接对等节点（带自动重连 + 心跳保活）
     * @param {string} peerUrl - 目标节点 URL
     * @param {boolean} [enableReconnect=true] - 是否启用自动重连
     */
    function connectToPeer(peerUrl, enableReconnect = true) {
        if (nodes.has(peerUrl) || peerUrl === nodeInfo.url) {
            console.log('⚠️ 节点已连接或为自身节点');
            return;
        }

        // 初始化重连状态（即使本次连接首次失败也能重试）
        if (enableReconnect) {
            _initReconnect(peerUrl);
        }

        const ws = new WebSocket(peerUrl);
        const connectionId = `conn_${Math.random().toString(36).substr(2, 9)}`;

        ws.on('open', () => {
            console.log(`🔗 已连接到对等节点: ${peerUrl}`);
            nodes.add(peerUrl);

            // 连接成功 → 清除重连状态（下次断开时重新累计）
            _clearReconnect(peerUrl);

            sendMessage(ws, {
                type: MESSAGE_TYPES.NODE_INFO,
                node: nodeInfo
            });

            // 连接后立即请求对方的节点列表
            sendMessage(ws, {
                type: MESSAGE_TYPES.NODE_LIST_REQUEST,
                fromNode: nodeInfo.url
            });

            sendMessage(ws, {
                type: MESSAGE_TYPES.QUERY_LATEST
            });

            // 连接后立即请求对方的待打包交易
            sendMessage(ws, {
                type: MESSAGE_TYPES.QUERY_PENDING_TXS,
                fromNode: nodeInfo.url
            });

            nodeConnections.set(connectionId, { ws, id: connectionId, url: peerUrl });

            // 启动心跳保活
            _startHeartbeat(ws, peerUrl, connectionId);
        });

        ws.on('message', (message) => {
            if (_messageHandler) {
                _messageHandler(ws, JSON.parse(message), connectionId);
            }
        });

        ws.on('close', () => {
            console.log(`🔌 与对等节点的连接已关闭: ${peerUrl}`);
            // 停止心跳
            _stopHeartbeat(connectionId);
            // 清理连接记录
            nodes.delete(peerUrl);
            nodeConnections.delete(connectionId);

            // 自动重连（如果不是主动断开）
            if (enableReconnect && reconnectState.has(peerUrl)) {
                _scheduleReconnect(peerUrl, (url) => connectToPeer(url, true));
            }
        });

        ws.on('error', (error) => {
            console.error(`❌ 连接对等节点出错: ${peerUrl}`, error.message || error);
            _stopHeartbeat(connectionId);
            nodes.delete(peerUrl);
            nodeConnections.delete(connectionId);

            // 连接失败也触发重连（如果是首次连接且未触发过 close）
            if (enableReconnect && reconnectState.has(peerUrl)) {
                _scheduleReconnect(peerUrl, (url) => connectToPeer(url, true));
            }
        });
    }

    function disconnectFromPeer(peerUrl) {
        if (!nodes.has(peerUrl)) {
            console.log(`⚠️ 节点未连接: ${peerUrl}`);
            return { success: false, message: '节点未连接' };
        }

        // 主动断开 → 清除重连状态，避免自动重连
        _clearReconnect(peerUrl);

        let found = false;

        for (const [connId, conn] of nodeConnections.entries()) {
            if (conn.url === peerUrl) {
                _stopHeartbeat(connId);
                try { if (conn.ws) conn.ws.close(); } catch (error) { /* 忽略 */ }
                nodeConnections.delete(connId);
                found = true;
                break;
            }
        }

        if (!found) {
            for (const client of wss.clients) {
                try {
                    const clientUrl = client.url || `ws://${client._socket.remoteAddress}:${client._socket.remotePort}`;
                    if (clientUrl.includes(peerUrl) || peerUrl.includes(clientUrl)) {
                        client.close();
                        found = true;
                        break;
                    }
                } catch (error) {
                    // 忽略访问 socket 信息时的错误
                }
            }
        }

        nodes.delete(peerUrl);

        const message = found ? `已断开与节点 ${peerUrl} 的连接` : `已从节点列表移除 ${peerUrl}`;
        console.log(`🔌 ${message}`);
        return { success: true, message };
    }

    async function getAllNodeInfo() {
        const nodeList = [];

        nodeList.push({
            ...nodeInfo,
            isSelf: true,
            connected: true,
            chainValid: starCoin.isChainValid()
        });

        for (const nodeUrl of nodes) {
            try {
                const response = await fetch(`${nodeUrl.replace('ws://', 'http://')}/api/blockchain`);
                const data = await response.json();
                nodeList.push({
                    id: `node_${data.port}`,
                    port: data.port,
                    url: nodeUrl,
                    httpUrl: `http://localhost:${data.port}`,
                    startedAt: new Date().toISOString(),
                    chainLength: data.stats.totalBlocks,
                    chainValid: data.isValid,
                    connected: true,
                    isSelf: false
                });
            } catch (error) {
                nodeList.push({
                    id: `node_${nodeUrl.split(':')[2]}`,
                    port: parseInt(nodeUrl.split(':')[2]),
                    url: nodeUrl,
                    httpUrl: nodeUrl.replace('ws://', 'http://'),
                    startedAt: null,
                    chainLength: null,
                    chainValid: null,
                    connected: false,
                    isSelf: false,
                    error: '无法连接'
                });
            }
        }

        return nodeList;
    }

    // ========== WebSocket 连接监听 ==========

    wss.on('connection', (ws, req) => {
        // 检查连接路径: 前端 WebSocket 客户端连接 /ws，P2P 节点连接 /
        const urlPath = req ? req.url : '/';
        if (urlPath === '/ws') {
            // 前端客户端连接——交给上层处理
            if (options.onFrontendConnection) {
                options.onFrontendConnection(ws, req);
            } else {
                console.log('🌐 前端 WS 客户端已连接（未注册处理函数）');
                ws.close();
            }
            return;
        }

        console.log('📡 新节点已连接');

        const connectionId = `conn_${Math.random().toString(36).substr(2, 9)}`;
        // 对于入站连接，我们不知道对方的 URL，用 remoteAddr 作为标识
        const remoteAddr = req ? `ws://${req.socket.remoteAddress}:${req.socket.remotePort}` : 'unknown';
        nodeConnections.set(connectionId, { ws, id: connectionId, url: remoteAddr });

        // 为入站 P2P 连接启动心跳保活
        _startHeartbeat(ws, remoteAddr, connectionId);

        ws.on('message', (message) => {
            if (_messageHandler) {
                _messageHandler(ws, JSON.parse(message), connectionId);
            }
        });

        ws.on('close', () => {
            console.log(`📡 节点已断开连接: ${remoteAddr}`);
            _stopHeartbeat(connectionId);
            nodeConnections.delete(connectionId);
        });

        ws.on('error', (error) => {
            console.error('❌ WebSocket错误:', error);
            _stopHeartbeat(connectionId);
            nodeConnections.delete(connectionId);
        });

        sendMessage(ws, {
            type: MESSAGE_TYPES.CHAIN,
            chain: starCoin.chain
        });

        sendMessage(ws, {
            type: MESSAGE_TYPES.NODE_INFO,
            node: nodeInfo
        });

        // 新连接建立后，主动请求对方的节点列表
        sendMessage(ws, {
            type: MESSAGE_TYPES.NODE_LIST_REQUEST,
            fromNode: nodeInfo.url
        });

        // 新连接建立后，主动请求对方的待打包交易
        sendMessage(ws, {
            type: MESSAGE_TYPES.QUERY_PENDING_TXS,
            fromNode: nodeInfo.url
        });
    });

    // ========== 组装核心 API ==========

    const core = {
        // 状态引用（供上层读取/扩展）
        wss,
        nodes,
        nodeConnections,
        nodeId,
        nodeInfo,
        // pendingPongs 对外暴露，供消息处理器层读取（PONG 超时清理）
        pendingPongs,
        // 核心方法
        sendMessage,
        broadcast,
        setHandler,
        getHandler,
        connectToPeer,
        disconnectFromPeer,
        getAllNodeInfo,
        // 工具
        MESSAGE_TYPES,
        // ====== 重连管理工具（供上层 p2p.js 使用） ======
        reconnect: {
            /** 初始化重连状态 */
            init: _initReconnect,
            /** 调度重连 */
            schedule: _scheduleReconnect,
            /** 取消重连 */
            clear: _clearReconnect,
            /** 检查是否有等待中的重连 */
            has: (url) => reconnectState.has(url),
            /** 获取重连状态副本 */
            getState: () => new Map(reconnectState)
        },
        // ====== 心跳管理工具 ======
        heartbeat: {
            /** 启动心跳 */
            start: _startHeartbeat,
            /** 停止心跳 */
            stop: _stopHeartbeat
        },
        // ====== 连接ID生成（用于一致性） ======
        generateConnectionId: (prefix = 'conn') =>
            `${prefix}_${Math.random().toString(36).substr(2, 9)}`
    };

    return core;
}

module.exports = { createP2PCore, MESSAGE_TYPES };