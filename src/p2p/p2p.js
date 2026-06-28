const WebSocket = require('ws');
const config = require('../config');
const logger = require('../logger');
const { createP2PCore, MESSAGE_TYPES } = require('./p2p-core');
const { createMessageHandlers } = require('./p2p-message-handlers');
const { createDiscoveryModule } = require('./p2p-discovery');

/**
 * 创建完整的 P2P 网络层（核心层 + 发现 + 同步）
 * - 核心网络通信由 p2p-core.js 提供
 * - 消息业务逻辑由 p2p-message-handlers.js 提供
 * - 本层负责：自动节点发现、链同步汇聚、交易池广播、链健康检查
 *
 * @param {http.Server} server - HTTP 服务器实例
 * @param {Blockchain} starCoin - 区块链实例
 * @param {number} PORT - 当前节点端口
 * @param {object} [options] - 可选配置
 * @param {function} [options.onChainChange] - 链数据变化时的回调（用于前端 WebSocket 推送）
 */
function createP2P(server, starCoin, PORT, options = {}) {
    const log = logger.module('P2P');

    // 1. 创建核心层（网络基础设施）
    const core = createP2PCore(server, starCoin, PORT, options);

    // 2. 创建消息处理器层（区块链业务逻辑）
    //    将网络基础设施以依赖注入方式传入，实现单向解耦
    const handlers = createMessageHandlers({
        sendMessage: core.sendMessage,
        broadcast: core.broadcast,
        nodeInfo: core.nodeInfo,
        nodes: core.nodes,
        pendingPongs: core.pendingPongs
    }, starCoin, options);

    // 3. 创建节点发现模块（独立于区块链业务逻辑）
    //    - 管理待连接节点队列，周期性扫描网络
    //    - 只依赖 core（网络基础设施），不依赖 starCoin
    const discovery = createDiscoveryModule(core, MESSAGE_TYPES);

    // 4. 将消息处理器注册到网络层
    //    此后 connectToPeer 和 wss.on('connection') 中的 ws.on('message')
    //    会自动调用 handlers.handleMessage
    core.setHandler(handlers.handleMessage);

    // ========== 同步状态 ==========
    const syncState = {
        isSyncing: false,
        lastSyncAt: null,
        candidates: [],
        syncCount: 0,
        expectedCount: 0,
        resolved: false
    };

    // ========== 同步候选链解析 ==========

    function resolveSyncCandidates() {
        if (syncState.resolved) return;
        syncState.resolved = true;
        syncState.isSyncing = false;

        const currentLength = starCoin.chain.length;
        const candidates = syncState.candidates;
        log.info('汇总完成', {
                candidateCount: candidates.length,
                currentLength,
                context: 'sync'
            });

        if (candidates.length === 0) {
            log.info('没有其他节点返回链，保持当前链');
            syncState.lastSyncAt = new Date().toISOString();
            return;
        }

        const validCandidates = candidates.filter(c => c.valid);
        if (validCandidates.length === 0) {
            log.warn('所有候选链都无效，拒绝同步');
            syncState.lastSyncAt = new Date().toISOString();
            return;
        }

        validCandidates.sort((a, b) => b.length - a.length);
        const best = validCandidates[0];

        log.info('最佳候选', { fromNode: best.fromNode, length: best.length });

        if (best.length <= currentLength) {
            log.info('当前链已是最长，无需替换');
            syncState.lastSyncAt = new Date().toISOString();
            return;
        }

        const myLatest = starCoin.getLatestBlock();
        const theirLatest = best.chain[best.chain.length - 1];
        if (myLatest.hash === theirLatest.previousHash) {
            log.info('最佳链与当前链尾部连续，直接追加');
            best.chain.slice(currentLength).forEach(b => starCoin.addBlock(b));
        } else {
            log.info('发生分叉，用最长有效链替换整条链');
            if (!starCoin.replaceChain(best.chain)) {
                log.warn('替换失败');
                syncState.lastSyncAt = new Date().toISOString();
                return;
            }
        }

        handlers.updateNodeInfo();
        handlers.broadcastLatest();
        syncState.lastSyncAt = new Date().toISOString();
        log.info('同步完成', { chainLength: starCoin.chain.length });

        // 同步完成后通知前端刷新
        if (options.onChainChange) {
            options.onChainChange();
        }
    }

    function syncWithPeers() {
        const connectedCount = core.nodeConnections.size +
            (Array.from(core.wss.clients).filter(c => c.readyState === 1).length);

        if (connectedCount === 0) {
            log.warn('当前没有连接的对等节点，无法同步');
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

        log.info('开始与节点同步', { expectedCount: syncState.expectedCount });

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
        log.info('已向节点发送同步请求', { sent });

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
                log.warn('同步超时，用已收到的候选进行解析');
                resolveSyncCandidates();
            }
        }, config.SYNC_TIMEOUT);

        return {
            success: true,
            message: '同步请求已广播，正在等待节点返回...',
            requestedNodes: sent,
            currentLength: starCoin.chain.length
        };
    }

    // ========== 扩展消息处理 ==========
    // 在 handlers.handleMessage 基础上注入 NODE_LIST / NODE_LIST_REQUEST 处理
    // 通过 core.setHandler 注册增强版，确保所有 ws.on('message') 都使用增强版

    const origHandleMessage = handlers.handleMessage;
    handlers.handleMessage = function enhancedHandleMessage(ws, message, connectionId) {
        switch (message.type) {
            case MESSAGE_TYPES.NODE_LIST:
                if (message.nodes && Array.isArray(message.nodes)) {
                    // 收到节点列表响应，处理发现的节点
                    discovery.handleDiscoveredNodes(message.nodes, message.fromNode || message.currentNode?.url);
                } else {
                    // 收到节点列表请求，发送自己的节点列表
                    core.sendMessage(ws, {
                        type: MESSAGE_TYPES.NODE_LIST,
                        nodes: Array.from(core.nodes),
                        fromNode: core.nodeInfo.url,
                        currentNode: core.nodeInfo
                    });
                }
                return;

            case MESSAGE_TYPES.NODE_LIST_REQUEST:
                core.sendMessage(ws, {
                    type: MESSAGE_TYPES.NODE_LIST,
                    nodes: Array.from(core.nodes),
                    fromNode: core.nodeInfo.url,
                    currentNode: core.nodeInfo
                });
                return;

            // ====== 交易池广播消息处理 ======

            case MESSAGE_TYPES.TRANSACTION:
                handleIncomingTransaction(message.transaction, message.fromNode);
                return;

            case MESSAGE_TYPES.QUERY_PENDING_TXS:
                // 收到交易池请求 → 发送本节点的待打包交易列表
                core.sendMessage(ws, {
                    type: MESSAGE_TYPES.PENDING_TXS,
                    transactions: starCoin.pendingTransactions,
                    fromNode: core.nodeInfo.url
                });
                return;

            case MESSAGE_TYPES.PENDING_TXS:
                handleIncomingPendingTxs(message.transactions, message.fromNode);
                return;
        }

        // 其余消息类型交给原始 handler
        return origHandleMessage.call(this, ws, message, connectionId);
    };

    // 将增强版 handler 注册到网络层
    core.setHandler(handlers.handleMessage);

    // ========== 交易池消息处理逻辑 ==========

    /**
     * 处理从 P2P 网络收到的单笔交易
     * - 验证签名
     * - 去重（按 tx.id）
     * - 加入本地交易池
     * - 不转发（防止广播风暴）
     */
    function handleIncomingTransaction(transaction, fromNode) {
        if (!transaction || !transaction.id) {
            log.warn('收到无效交易，忽略');
            return;
        }

        // 去重检查
        if (starCoin.hasPendingTransaction(transaction.id)) {
            return; // 已存在，静默忽略
        }

        log.info('收到来自节点的交易', { fromNode, txId: transaction.id.substring(0, 16) });

        // 使用 blockchain 的 addPendingTransaction 方法（跳过余额检查）
        const result = starCoin.addPendingTransaction(transaction, true);
        if (result.success) {
            log.info('交易已加入本地交易池', { poolSize: starCoin.pendingTransactions.length });
        } else {
            log.warn('交易拒绝加入', { error: result.error });
        }
    }

    /**
     * 处理从 P2P 网络收到的待打包交易列表
     * - 逐笔去重、验证、合并到本地交易池
     */
    function handleIncomingPendingTxs(transactions, fromNode) {
        if (!Array.isArray(transactions) || transactions.length === 0) return;

        let added = 0;
        let skipped = 0;
        for (const tx of transactions) {
            if (starCoin.hasPendingTransaction(tx.id)) {
                skipped++;
                continue;
            }
            const result = starCoin.addPendingTransaction(tx, true);
            if (result.success) {
                added++;
            } else {
                skipped++;
            }
        }

        if (added > 0) {
            log.info('从节点合并了新交易', { fromNode, added, skipped, poolSize: starCoin.pendingTransactions.length });
        }
    }

    // ========== 交易池广播同步方法 ==========

    /**
     * 广播一笔交易到所有对等节点（单笔广播）
     * @param {object} tx - 交易对象
     */
    function broadcastTransaction(tx) {
        const connectedCount = core.nodes.size;
        if (connectedCount === 0) return;

        log.info('广播交易到节点', { txId: tx.id.substring(0, 16), count: connectedCount });
        handlers.broadcastTransaction(tx);
    }

    /**
     * 广播整个交易池到所有对等节点
     */
    function broadcastPendingTxs() {
        const connectedCount = core.nodes.size;
        if (connectedCount === 0) return;
        if (starCoin.pendingTransactions.length === 0) return;

        log.info('广播待打包交易到节点', { txCount: starCoin.pendingTransactions.length, count: connectedCount });
        handlers.broadcastPendingTxs();
    }

    /**
     * 向所有对等节点请求交易池并合并
     * - 广播 QUERY_PENDING_TXS 请求
     * - 各节点通过 PENDING_TXS 回复
     * - 逐笔验证合并
     */
    function syncPendingTxs() {
        const connectedCount = core.nodes.size;
        if (connectedCount === 0) {
            log.warn('没有已连接节点，无法同步');
            return { success: false, message: '没有已连接节点' };
        }

        log.info('向节点请求交易池同步', { count: connectedCount });

        const requestMsg = {
            type: MESSAGE_TYPES.QUERY_PENDING_TXS,
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

        return { success: true, message: `已向 ${connectedCount} 个节点发送交易池同步请求` };
    }

    // ========== 扩展 handleChainResponse：注入同步汇聚模式 ==========
    const origHandleChainResponse = handlers.handleChainResponse;
    handlers.handleChainResponse = function enhancedHandleChainResponse(chain, fromNode) {
        // ------ 同步汇聚模式 ------
        if (syncState.isSyncing && fromNode) {
            log.info('收到节点的链', { fromNode, length: chain.length });
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
            log.warn('发现链状态无效，开始自动修复');
            const removed = starCoin.repairChain();
            if (removed.length > 0) {
                log.info('已截断区块', { count: removed.length });
            }
            // 修复后尝试从其他节点同步以恢复
            const syncResult = syncWithPeers();
            log.info('已触发同步', { message: syncResult.message });
            return {
                status: 'repaired',
                removedBlocks: removed.length,
                syncTriggered: true,
                chainLength: starCoin.chain.length
            };
        }
        return { status: 'healthy', chainLength: starCoin.chain.length };
    }

    // 启动定期健康检查
    function startHealthCheck(intervalMs = config.SYNC_HEALTH_CHECK_INTERVAL) {
        if (healthCheckTimer) return;
        log.info('健康检查已启动', { interval: intervalMs / 1000 });
        healthCheckTimer = setInterval(() => {
            checkChainHealth();
        }, intervalMs);
    }

    // 停止定期健康检查
    function stopHealthCheck() {
        if (healthCheckTimer) {
            clearInterval(healthCheckTimer);
            healthCheckTimer = null;
            log.info('健康检查已停止');
        }
    }

    // ========== 启动自动发现和健康检查 ==========
    // 延时启动，确保服务器完全就绪
    setTimeout(() => {
        discovery.startDiscovery();
        startHealthCheck();
        // 首次启动时立即发起一次发现请求
        setTimeout(() => discovery.requestNodeLists(), 2000);
    }, 3000);

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
        broadcastLatest: handlers.broadcastLatest,
        updateNodeInfo: handlers.updateNodeInfo,
        broadcastNodeInfo: handlers.broadcastNodeInfo,

        // 同步方法
        syncWithPeers,
        getSyncState: () => ({
            isSyncing: syncState.isSyncing,
            lastSyncAt: syncState.lastSyncAt,
            candidateCount: syncState.candidates.length,
            candidates: syncState.candidates
        }),

        // 交易池广播方法
        broadcastTransaction,
        broadcastPendingTxs,
        syncPendingTxs,

        // 健康检查方法
        checkChainHealth,
        startHealthCheck,
        stopHealthCheck,

        // 发现方法（由 p2p-discovery.js 提供）
        startDiscovery: discovery.startDiscovery,
        stopDiscovery: discovery.stopDiscovery,
        getDiscoveryStatus: discovery.getDiscoveryStatus,
        requestNodeLists: discovery.requestNodeLists,

        // 内部引用（调试/扩展用）
        wss: core.wss
    };
}

module.exports = { createP2P, MESSAGE_TYPES };