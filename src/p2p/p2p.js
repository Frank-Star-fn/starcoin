const WebSocket = require('ws');
const { createP2PCore, MESSAGE_TYPES } = require('./p2p-core');

/**
 * 创建完整的 P2P 网络层（核心层 + 发现 + 同步）
 * - 核心网络通信由 p2p-core.js 提供
 * - 自动节点发现：定期向已连接节点请求节点列表，尝试连接新节点
 * - 链同步：向所有节点请求完整链，汇聚候选后择优替换
 *
 * @param {http.Server} server - HTTP 服务器实例
 * @param {Blockchain} starCoin - 区块链实例
 * @param {number} PORT - 当前节点端口
 * @param {object} [options] - 可选配置
 * @param {function} [options.onChainChange] - 链数据变化时的回调（用于前端 WebSocket 推送）
 */
function createP2P(server, starCoin, PORT, options = {}) {
    // 1. 创建核心层，传递 onChainChange 回调
    const core = createP2PCore(server, starCoin, PORT, options);

    // ========== 同步状态 ==========
    const syncState = {
        isSyncing: false,
        lastSyncAt: null,
        candidates: [],
        syncCount: 0,
        expectedCount: 0,
        resolved: false
    };

    // ========== 自动发现状态 ==========
    const pendingNodes = new Set();      // 待连接节点队列（去重）
    const connectingNodes = new Set();   // 正在连接中的节点 URL
    const discoveryConfig = {
        interval: 30000,                 // 发现间隔（毫秒）
        maxPeers: 20,                    // 最大对等节点数
        maxConnectPerRound: 3,           // 每轮最大尝试连接数
        enabled: true                    // 是否启用自动发现
    };
    let discoveryTimer = null;           // 定时器句柄
    let isDiscovering = false;           // 是否正在发现中

    // ========== 自动节点发现 ==========

    // 处理从其他节点发现的节点 URL，加入待连接队列
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

    // 向所有已连接节点广播节点列表请求
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

    // 尝试连接待连接队列中的节点
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

    // 自动连接单个节点（与手动 connectToPeer 逻辑类似，但管理 connectingNodes）
    function _autoConnect(nodeUrl) {
        if (core.nodes.has(nodeUrl) || nodeUrl === core.nodeInfo.url) {
            connectingNodes.delete(nodeUrl);
            return;
        }

        const ws = new WebSocket(nodeUrl);
        const connectionId = `auto_${Math.random().toString(36).substr(2, 9)}`;

        ws.on('open', () => {
            console.log(`🔗 [自动发现] 已连接到: ${nodeUrl}`);
            core.nodes.add(nodeUrl);
            connectingNodes.delete(nodeUrl);

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

            core.nodeConnections.set(connectionId, { ws, id: connectionId, url: nodeUrl });
        });

        ws.on('message', (message) => {
            core.handleMessage(ws, JSON.parse(message), connectionId);
        });

        ws.on('close', () => {
            console.log(`🔌 [自动发现] 连接已关闭: ${nodeUrl}`);
            core.nodes.delete(nodeUrl);
            core.nodeConnections.delete(connectionId);
            connectingNodes.delete(nodeUrl);
        });

        ws.on('error', (error) => {
            console.error(`❌ [自动发现] 连接失败: ${nodeUrl}`, error.message || error);
            core.nodes.delete(nodeUrl);
            core.nodeConnections.delete(connectionId);
            connectingNodes.delete(nodeUrl);
        });
    }

    // 启动自动发现定时器
    function startDiscovery() {
        if (discoveryTimer) return;
        discoveryConfig.enabled = true;
        console.log(`🔍 [自动发现] 已启动（间隔: ${discoveryConfig.interval / 1000}秒, 最大节点数: ${discoveryConfig.maxPeers}）`);
        discoveryTimer = setInterval(() => {
            requestNodeLists();
        }, discoveryConfig.interval);
    }

    // 停止自动发现定时器
    function stopDiscovery() {
        if (discoveryTimer) {
            clearInterval(discoveryTimer);
            discoveryTimer = null;
        }
        discoveryConfig.enabled = false;
        console.log('🔍 [自动发现] 已停止');
    }

    // 获取自动发现状态
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

        core.updateNodeInfo();
        core.broadcastLatest();
        syncState.lastSyncAt = new Date().toISOString();
        console.log(`✅ [同步] 完成，当前链长度: ${starCoin.chain.length}`);

        // 同步完成后通知前端刷新
        if (options.onChainChange) {
            options.onChainChange();
        }
    }

    function syncWithPeers() {
        const connectedCount = core.nodeConnections.size +
            (Array.from(core.wss.clients).filter(c => c.readyState === 1).length);

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
        syncState.expectedCount = core.nodeConnections.size;

        console.log(`🔄 [同步] 开始与 ${syncState.expectedCount} 个节点同步...`);

        let sent = 0;
        core.nodeConnections.forEach((conn) => {
            if (conn.ws && conn.ws.readyState === 1) {
                core.sendMessage(conn.ws, {
                    type: MESSAGE_TYPES.SYNC_REQUEST,
                    fromNode: core.nodeInfo.url
                });
                sent++;
            }
        });

        core.wss.clients.forEach((client) => {
            if (client.readyState === 1) {
                core.sendMessage(client, {
                    type: MESSAGE_TYPES.SYNC_REQUEST,
                    fromNode: core.nodeInfo.url
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

    // ========== 扩展核心消息处理 ==========
    // 在 core.handleMessage 基础上注入 NODE_LIST / NODE_LIST_REQUEST 处理
    // 这样 connectToPeer 和 wss.on('connection') 中的 ws.on('message')
    // 都能自动使用增强后的版本（因为它们引用 core.handleMessage）

    const origHandleMessage = core.handleMessage;
    core.handleMessage = function enhancedHandleMessage(ws, message, connectionId) {
        switch (message.type) {
            case MESSAGE_TYPES.NODE_LIST:
                if (message.nodes && Array.isArray(message.nodes)) {
                    // 收到节点列表响应，处理发现的节点
                    handleDiscoveredNodes(message.nodes, message.fromNode || message.currentNode?.url);
                } else {
                    // 收到节点列表请求，发送自己的节点列表
                    core.sendMessage(ws, {
                        type: MESSAGE_TYPES.NODE_LIST,
                        nodes: Array.from(core.nodes),
                        fromNode: core.nodeInfo.url,
                        currentNode: core.nodeInfo
                    });
                }
                return; // 已处理，不再走原始 handler

            case MESSAGE_TYPES.NODE_LIST_REQUEST:
                // 主动请求节点列表，发送自己的列表作为响应
                core.sendMessage(ws, {
                    type: MESSAGE_TYPES.NODE_LIST,
                    nodes: Array.from(core.nodes),
                    fromNode: core.nodeInfo.url,
                    currentNode: core.nodeInfo
                });
                return; // 已处理，不再走原始 handler
        }

        // 其余消息类型交给原始 handler
        return origHandleMessage.call(this, ws, message, connectionId);
    };

    // 扩展 handleChainResponse：注入同步汇聚模式
    const origHandleChainResponse = core.handleChainResponse;
    core.handleChainResponse = function enhancedHandleChainResponse(chain, fromNode) {
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

        // 其余情况交给原始 handler
        return origHandleChainResponse.call(this, chain, fromNode);
    };

    // ========== 链健康检查与自动恢复 ==========

    let healthCheckTimer = null;

    // 检查当前链是否有效，无效则自动修复并从其他节点同步
    function checkChainHealth() {
        if (!starCoin.isChainValid()) {
            console.warn('🏥 [健康检查] 发现链状态无效，开始自动修复...');
            const removed = starCoin.repairChain();
            if (removed.length > 0) {
                console.log(`🏥 [健康检查] 已截断 ${removed.length} 个区块`);
            }
            // 修复后尝试从其他节点同步以恢复
            const syncResult = syncWithPeers();
            console.log(`🏥 [健康检查] 已触发同步: ${syncResult.message}`);
            return {
                status: 'repaired',
                removedBlocks: removed.length,
                syncTriggered: true,
                chainLength: starCoin.chain.length
            };
        }
        return { status: 'healthy', chainLength: starCoin.chain.length };
    }

    // 启动定期健康检查（默认每 30 秒）
    function startHealthCheck(intervalMs = 30000) {
        if (healthCheckTimer) return;
        console.log(`🏥 [健康检查] 已启动（间隔: ${intervalMs / 1000}秒）`);
        healthCheckTimer = setInterval(() => {
            checkChainHealth();
        }, intervalMs);
    }

    // 停止定期健康检查
    function stopHealthCheck() {
        if (healthCheckTimer) {
            clearInterval(healthCheckTimer);
            healthCheckTimer = null;
            console.log('🏥 [健康检查] 已停止');
        }
    }

    // ========== 启动自动发现（首次连接其他节点后才开始周期性扫描） ==========
    // 如果尚未连接任何节点，先不启动定时器，等有节点后再启动
    if (discoveryConfig.enabled) {
        // 延时启动，确保服务器完全就绪
        setTimeout(() => {
            startDiscovery();
            startHealthCheck(); // 同时启动链健康检查
            // 首次启动时立即发起一次发现请求
            setTimeout(() => requestNodeLists(), 2000);
        }, 3000);
    }

    // ========== 组装最终 API ==========

    return {
        // 核心属性
        nodeInfo: core.nodeInfo,
        getNodeUrls: () => Array.from(core.nodes),
        getConnectedCount: () => core.nodes.size,

        // 核心方法（直接透传）
        connectToPeer: core.connectToPeer,
        disconnectFromPeer: core.disconnectFromPeer,
        getAllNodeInfo: core.getAllNodeInfo,
        broadcastLatest: core.broadcastLatest,
        updateNodeInfo: core.updateNodeInfo,
        broadcastNodeInfo: core.broadcastNodeInfo,

        // 同步方法
        syncWithPeers,
        getSyncState: () => ({
            isSyncing: syncState.isSyncing,
            lastSyncAt: syncState.lastSyncAt,
            candidateCount: syncState.candidates.length,
            candidates: syncState.candidates
        }),

        // 健康检查方法
        checkChainHealth,
        startHealthCheck,
        stopHealthCheck,

        // 发现方法
        startDiscovery,
        stopDiscovery,
        getDiscoveryStatus,
        requestNodeLists,

        // 内部引用（调试/扩展用）
        wss: core.wss
    };
}

module.exports = { createP2P, MESSAGE_TYPES };