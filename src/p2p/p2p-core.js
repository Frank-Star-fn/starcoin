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
    SYNC_REQUEST: 'SYNC_REQUEST'
};

/**
 * 创建 P2P 核心网络层
 * - 管理 WebSocket 服务器
 * - 节点状态跟踪 (nodes, nodeConnections, nodeInfo)
 * - 消息收发工具 (sendMessage, broadcast, broadcastLatest 等)
 * - 基础消息路由分发 (handleMessage)
 * - 节点连接管理 (connectToPeer, disconnectFromPeer, getAllNodeInfo)
 * - ws server 连接事件监听
 *
 * @param {http.Server} server - HTTP 服务器实例
 * @param {Blockchain} starCoin - 区块链实例
 * @param {number} PORT - 当前节点端口
 */
function createP2PCore(server, starCoin, PORT) {
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

    // ========== 内部工具函数 ==========

    function sendMessage(ws, message) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
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

    function broadcastLatest() {
        broadcast({
            type: MESSAGE_TYPES.BLOCK,
            block: starCoin.getLatestBlock()
        });
    }

    function broadcastQueryAll() {
        broadcast({
            type: MESSAGE_TYPES.QUERY_ALL
        });
    }

    function broadcastNodeInfo() {
        broadcast({
            type: MESSAGE_TYPES.NODE_INFO,
            node: nodeInfo
        });
    }

    function updateNodeInfo() {
        nodeInfo.chainLength = starCoin.chain.length;
        nodeInfo.lastUpdated = new Date().toISOString();
    }

    // ========== 基础消息处理（纯数据层面） ==========
    // 注意：NODE_LIST / NODE_LIST_REQUEST 由上层 (p2p.js) 通过替换 handleMessage 扩展

    function handleMessage(ws, message, connectionId) {
        switch (message.type) {
            case MESSAGE_TYPES.QUERY_LATEST:
                sendMessage(ws, {
                    type: MESSAGE_TYPES.BLOCK,
                    block: starCoin.getLatestBlock()
                });
                break;
            case MESSAGE_TYPES.QUERY_ALL:
                sendMessage(ws, {
                    type: MESSAGE_TYPES.CHAIN,
                    chain: starCoin.chain
                });
                break;
            case MESSAGE_TYPES.CHAIN:
                handleChainResponse(message.chain, message.fromNode);
                break;
            case MESSAGE_TYPES.BLOCK:
                handleBlockResponse(message.block);
                break;
            case MESSAGE_TYPES.NODE_INFO:
                handleNodeInfo(message.node);
                break;
            case MESSAGE_TYPES.CHAIN_LENGTH:
                sendMessage(ws, {
                    type: MESSAGE_TYPES.CHAIN_LENGTH,
                    length: starCoin.chain.length,
                    latestHash: starCoin.getLatestBlock().hash,
                    fromNode: nodeInfo.url
                });
                break;
            case MESSAGE_TYPES.SYNC_REQUEST:
                console.log(`🔄 收到来自 ${message.fromNode || '某节点'} 的同步请求，发送完整链`);
                sendMessage(ws, {
                    type: MESSAGE_TYPES.CHAIN,
                    chain: starCoin.chain,
                    fromNode: nodeInfo.url
                });
                break;
        }
    }

    function handleChainResponse(chain, fromNode) {
        if (!chain || !Array.isArray(chain) || chain.length === 0) {
            console.log('📥 收到空链，忽略');
            return;
        }

        // ------ 常规被动接收模式 ------
        const latestBlockReceived = chain[chain.length - 1];
        const latestBlockHeld = starCoin.getLatestBlock();

        if (latestBlockReceived.index > latestBlockHeld.index) {
            console.log(`📥 收到更长的链，长度: ${chain.length}，当前链长度: ${starCoin.chain.length}`);

            if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
                if (starCoin.addBlock(latestBlockReceived)) {
                    // 添加后验证链状态，如果无效则自动修复
                    if (!starCoin.isChainValid()) {
                        console.warn('🔧 [P2P] 添加区块后链状态无效，自动修复...');
                        starCoin.repairChain();
                    }
                    broadcastLatest();
                    updateNodeInfo();
                }
            } else if (chain.length === 1) {
                console.log('📥 收到创世区块');
            } else {
                console.log('🔄 需要替换整个链，正在验证...');
                if (!starCoin.isChainValid(chain)) {
                    console.log('❌ 收到的链无效，拒绝替换');
                    return;
                }
                if (starCoin.replaceChain(chain)) {
                    console.log('✅ 已替换为更长的链，新长度: ' + starCoin.chain.length);
                    // 替换后验证链状态
                    if (!starCoin.isChainValid()) {
                        console.warn('🔧 [P2P] 替换链后状态无效，自动修复...');
                        starCoin.repairChain();
                    }
                    broadcastLatest();
                    updateNodeInfo();
                }
            }
        } else {
            console.log(`📥 收到的链不更长（${chain.length} vs ${starCoin.chain.length}），忽略`);
        }
    }

    function handleBlockResponse(block) {
        const latestBlockHeld = starCoin.getLatestBlock();

        if (block.index <= latestBlockHeld.index) {
            // 即使索引相同也可能是不同区块，检查链状态是否有效
            if (block.index === latestBlockHeld.index && !starCoin.isChainValid()) {
                console.warn('🔧 [P2P] 收到同索引区块且本地链无效，自动修复...');
                starCoin.repairChain();
            }
            return;
        }

        if (latestBlockHeld.hash === block.previousHash) {
            if (starCoin.addBlock(block)) {
                // 添加后验证链状态
                if (!starCoin.isChainValid()) {
                    console.warn('🔧 [P2P handleBlockResponse] 添加区块后链无效，自动修复...');
                    starCoin.repairChain();
                }
                broadcastLatest();
                updateNodeInfo();
            }
        } else {
            console.log('🔄 需要查询完整链');
            broadcastQueryAll();
        }
    }

    function handleNodeInfo(node) {
        if (node.url !== nodeInfo.url) {
            nodes.add(node.url);
            console.log(`📝 发现新节点: ${node.url}`);
        }
    }

    // ========== 节点连接管理 ==========

    function connectToPeer(peerUrl) {
        if (nodes.has(peerUrl) || peerUrl === nodeInfo.url) {
            console.log('⚠️ 节点已连接或为自身节点');
            return;
        }

        const ws = new WebSocket(peerUrl);
        const connectionId = `conn_${Math.random().toString(36).substr(2, 9)}`;

        ws.on('open', () => {
            console.log(`🔗 已连接到对等节点: ${peerUrl}`);
            nodes.add(peerUrl);

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

            nodeConnections.set(connectionId, { ws, id: connectionId, url: peerUrl });
        });

        ws.on('message', (message) => {
            core.handleMessage(ws, JSON.parse(message), connectionId);
        });

        ws.on('close', () => {
            console.log(`🔌 与对等节点的连接已关闭: ${peerUrl}`);
            nodes.delete(peerUrl);
            nodeConnections.delete(connectionId);
        });

        ws.on('error', (error) => {
            console.error(`❌ 连接对等节点出错: ${peerUrl}`, error.message || error);
            nodes.delete(peerUrl);
            nodeConnections.delete(connectionId);
        });
    }

    function disconnectFromPeer(peerUrl) {
        if (!nodes.has(peerUrl)) {
            console.log(`⚠️ 节点未连接: ${peerUrl}`);
            return { success: false, message: '节点未连接' };
        }

        let found = false;

        for (const [connId, conn] of nodeConnections.entries()) {
            if (conn.url === peerUrl) {
                try {
                    if (conn.ws) conn.ws.close();
                } catch (error) {
                    console.error('关闭连接时出错:', error.message);
                }
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
        updateNodeInfo();

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

    wss.on('connection', (ws) => {
        console.log('📡 新节点已连接');

        const connectionId = `conn_${Math.random().toString(36).substr(2, 9)}`;
        nodeConnections.set(connectionId, { ws, id: connectionId });

        ws.on('message', (message) => {
            core.handleMessage(ws, JSON.parse(message), connectionId);
        });

        ws.on('close', () => {
            console.log('📡 节点已断开连接');
            nodeConnections.delete(connectionId);
        });

        ws.on('error', (error) => {
            console.error('❌ WebSocket错误:', error);
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
    });

    // ========== 组装核心 API ==========

    const core = {
        // 状态引用（供上层读取/扩展）
        wss,
        nodes,
        nodeConnections,
        nodeId,
        nodeInfo,
        // 核心方法
        sendMessage,
        broadcast,
        broadcastLatest,
        broadcastQueryAll,
        broadcastNodeInfo,
        updateNodeInfo,
        handleMessage,    // 可被上层替换扩展
        handleChainResponse,
        handleBlockResponse,
        handleNodeInfo,
        connectToPeer,
        disconnectFromPeer,
        getAllNodeInfo,
        // 工具
        MESSAGE_TYPES
    };

    return core;
}

module.exports = { createP2PCore, MESSAGE_TYPES };