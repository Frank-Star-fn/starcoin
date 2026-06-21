const WebSocket = require('ws');

// 消息类型
const MESSAGE_TYPES = {
    CHAIN: 'CHAIN',
    BLOCK: 'BLOCK',
    QUERY_LATEST: 'QUERY_LATEST',
    QUERY_ALL: 'QUERY_ALL',
    NODE_INFO: 'NODE_INFO',
    NODE_LIST: 'NODE_LIST',
    CHAIN_LENGTH: 'CHAIN_LENGTH',
    SYNC_REQUEST: 'SYNC_REQUEST'
};

/**
 * 初始化 P2P 网络层
 * @param {http.Server} server - HTTP 服务器实例
 * @param {Blockchain} starCoin - 区块链实例
 * @param {number} PORT - 当前节点端口
 */
function createP2P(server, starCoin, PORT) {
    // WebSocket 服务器
    const wss = new WebSocket.Server({ server });

    // 节点状态
    const nodes = new Set();
    const nodeConnections = new Map(); // 存储节点连接
    const nodeId = `node_${PORT}_${Math.random().toString(36).substr(2, 9)}`;

    // 同步状态
    const syncState = {
        isSyncing: false,
        lastSyncAt: null,
        candidates: [],
        syncCount: 0,
        expectedCount: 0,
        resolved: false
    };

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

    // ========== 消息处理 ==========

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
            case MESSAGE_TYPES.NODE_LIST:
                sendMessage(ws, {
                    type: MESSAGE_TYPES.NODE_LIST,
                    nodes: Array.from(nodes),
                    currentNode: nodeInfo
                });
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

        // ------ 同步汇聚模式 ------
        if (syncState.isSyncing && fromNode) {
            console.log(`📥 [同步] 收到节点 ${fromNode} 的链，长度 ${chain.length}`);
            syncState.candidates.push({
                fromNode: fromNode,
                chain: chain,
                length: chain.length,
                valid: starCoin.isChainValid(chain)
            });
            syncState.syncCount++;

            if (syncState.syncCount >= syncState.expectedCount) {
                resolveSyncCandidates();
            }
            return;
        }

        // ------ 常规被动接收模式 ------
        const latestBlockReceived = chain[chain.length - 1];
        const latestBlockHeld = starCoin.getLatestBlock();

        if (latestBlockReceived.index > latestBlockHeld.index) {
            console.log(`📥 收到更长的链，长度: ${chain.length}，当前链长度: ${starCoin.chain.length}`);

            if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
                if (starCoin.addBlock(latestBlockReceived)) {
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
            console.log('📥 收到的区块不新，忽略');
            return;
        }

        if (latestBlockHeld.hash === block.previousHash) {
            if (starCoin.addBlock(block)) {
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

    // ========== 同步候选链解析 ==========

    function resolveSyncCandidates() {
        if (syncState.resolved) return;
        syncState.resolved = true;
        syncState.isSyncing = false;

        const currentLength = starCoin.chain.length;
        const candidates = syncState.candidates;
        console.log(`🔄 [同步] 汇总完成，共 ${candidates.length} 个候选链（当前链长度: ${currentLength}）`);

        if (candidates.length === 0) {
            console.log('ℹ️  没有其他节点返回链，保持当前链');
            syncState.lastSyncAt = new Date().toISOString();
            return;
        }

        const validCandidates = candidates.filter(c => c.valid);
        if (validCandidates.length === 0) {
            console.log('❌ [同步] 所有候选链都无效，拒绝同步');
            syncState.lastSyncAt = new Date().toISOString();
            return;
        }

        validCandidates.sort((a, b) => b.length - a.length);
        const best = validCandidates[0];

        console.log(`🏆 [同步] 最佳候选: 节点 ${best.fromNode}，长度 ${best.length}`);

        if (best.length <= currentLength) {
            console.log('ℹ️  当前链已是最长，无需替换');
            syncState.lastSyncAt = new Date().toISOString();
            return;
        }

        const myLatest = starCoin.getLatestBlock();
        const theirLatest = best.chain[best.chain.length - 1];
        if (myLatest.hash === theirLatest.previousHash) {
            console.log('🔄 [同步] 最佳链与当前链尾部连续，直接追加');
            best.chain.slice(currentLength).forEach(b => starCoin.addBlock(b));
        } else {
            console.log('🔄 [同步] 发生分叉，用最长有效链替换整条链');
            if (!starCoin.replaceChain(best.chain)) {
                console.log('❌ [同步] 替换失败');
                syncState.lastSyncAt = new Date().toISOString();
                return;
            }
        }

        updateNodeInfo();
        broadcastLatest();
        syncState.lastSyncAt = new Date().toISOString();
        console.log(`✅ [同步] 完成，当前链长度: ${starCoin.chain.length}`);
    }

    // ========== 节点连接管理 ==========

    function syncWithPeers() {
        const connectedCount = nodeConnections.size +
            (Array.from(wss.clients).filter(c => c.readyState === 1).length);

        if (connectedCount === 0) {
            console.log('⚠️  [同步] 当前没有连接的对等节点，无法同步');
            return {
                success: false,
                message: '没有可连接的对等节点',
                currentLength: starCoin.chain.length
            };
        }

        syncState.isSyncing = true;
        syncState.resolved = false;
        syncState.candidates = [];
        syncState.syncCount = 0;
        syncState.expectedCount = nodeConnections.size;

        console.log(`🔄 [同步] 开始与 ${syncState.expectedCount} 个节点同步...`);

        let sent = 0;
        nodeConnections.forEach((conn) => {
            if (conn.ws && conn.ws.readyState === 1) {
                sendMessage(conn.ws, {
                    type: MESSAGE_TYPES.SYNC_REQUEST,
                    fromNode: nodeInfo.url
                });
                sent++;
            }
        });

        wss.clients.forEach((client) => {
            if (client.readyState === 1) {
                sendMessage(client, {
                    type: MESSAGE_TYPES.SYNC_REQUEST,
                    fromNode: nodeInfo.url
                });
                sent++;
            }
        });

        syncState.expectedCount = sent;
        console.log(`📡 [同步] 已向 ${sent} 个节点发送同步请求`);

        if (sent === 0) {
            syncState.isSyncing = false;
            return {
                success: false,
                message: '无法向节点发送同步请求',
                currentLength: starCoin.chain.length
            };
        }

        setTimeout(() => {
            if (!syncState.resolved) {
                console.log('⏱️  [同步] 超时，用已收到的候选进行解析');
                resolveSyncCandidates();
            }
        }, 10000);

        return {
            success: true,
            message: '同步请求已广播，正在等待节点返回...',
            requestedNodes: sent,
            currentLength: starCoin.chain.length
        };
    }

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

            sendMessage(ws, {
                type: MESSAGE_TYPES.QUERY_LATEST
            });

            nodeConnections.set(connectionId, { ws, id: connectionId, url: peerUrl });
        });

        ws.on('message', (message) => {
            handleMessage(ws, JSON.parse(message), connectionId);
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
            handleMessage(ws, JSON.parse(message), connectionId);
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

        sendMessage(ws, {
            type: MESSAGE_TYPES.NODE_LIST
        });
    });

    // ========== 对外暴露的接口 ==========

    return {
        nodeInfo,
        getNodeUrls: () => Array.from(nodes),
        getConnectedCount: () => nodes.size,
        connectToPeer,
        disconnectFromPeer,
        getAllNodeInfo,
        syncWithPeers,
        getSyncState: () => ({
            isSyncing: syncState.isSyncing,
            lastSyncAt: syncState.lastSyncAt,
            candidateCount: syncState.candidates.length,
            candidates: syncState.candidates
        }),
        broadcastLatest,
        updateNodeInfo,
        wss
    };
}

module.exports = { createP2P, MESSAGE_TYPES };