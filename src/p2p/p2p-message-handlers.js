const { MESSAGE_TYPES } = require('./p2p-core');

/**
 * 创建消息处理器层
 *
 * 职责：处理所有区块链业务相关的消息（链同步、区块追加、交易池等）
 * 与 p2p-core.js 的网络基础设施层解耦，通过依赖注入使用网络能力
 *
 * 设计模式：工厂函数 + 依赖注入
 * - p2p-core.js 提供网络基础设施（sendMessage, broadcast, nodeInfo 等）
 * - 本模块提供消息业务逻辑（链验证、区块处理等）
 * - 上层 p2p.js 将两者组合，并可在此基础上扩展
 *
 * @param {object} network - 网络基础设施依赖
 * @param {function} network.sendMessage - 发送消息到指定连接
 * @param {function} network.broadcast - 广播消息到所有连接
 * @param {object} network.nodeInfo - 本节点信息
 * @param {Set} network.nodes - 已连接节点 URL 集合
 * @param {Map} network.pendingPongs - 心跳 PONG 超时映射表
 * @param {Blockchain} starCoin - 区块链实例
 * @param {object} [options] - 可选配置
 * @param {function} [options.onChainChange] - 链数据变化时的回调
 */
function createMessageHandlers(network, starCoin, options = {}) {
    // ========== 业务广播（封装网络层的 broadcast） ==========

    function broadcastLatest() {
        network.broadcast({
            type: MESSAGE_TYPES.BLOCK,
            block: starCoin.getLatestBlock()
        });
    }

    function broadcastQueryAll() {
        network.broadcast({
            type: MESSAGE_TYPES.QUERY_ALL
        });
    }

    function broadcastNodeInfo() {
        network.broadcast({
            type: MESSAGE_TYPES.NODE_INFO,
            node: network.nodeInfo
        });
    }

    /**
     * 向所有已连接节点广播一笔交易（P2P 交易池同步）
     * @param {object} tx - 交易对象
     */
    function broadcastTransaction(tx) {
        network.broadcast({
            type: MESSAGE_TYPES.TRANSACTION,
            transaction: tx,
            fromNode: network.nodeInfo.url
        });
    }

    /**
     * 向所有已连接节点广播本节点的待打包交易列表
     */
    function broadcastPendingTxs() {
        network.broadcast({
            type: MESSAGE_TYPES.PENDING_TXS,
            transactions: starCoin.pendingTransactions,
            fromNode: network.nodeInfo.url
        });
    }

    /** 更新节点信息中的链状态 */
    function updateNodeInfo() {
        network.nodeInfo.chainLength = starCoin.chain.length;
        network.nodeInfo.lastUpdated = new Date().toISOString();
    }

    // ========== 链/区块消息处理 ==========

    function handleChainResponse(chain, fromNode) {
        if (!chain || !Array.isArray(chain) || chain.length === 0) {
            console.log('📥 收到空链，忽略');
            return;
        }

        const latestBlockReceived = chain[chain.length - 1];
        const latestBlockHeld = starCoin.getLatestBlock();

        if (latestBlockReceived.index > latestBlockHeld.index) {
            console.log(`📥 收到更长的链，长度: ${chain.length}，当前链长度: ${starCoin.chain.length}`);

            if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
                if (starCoin.addBlock(latestBlockReceived)) {
                    if (!starCoin.isChainValid()) {
                        console.warn('🔧 [P2P] 添加区块后链状态无效，自动修复...');
                        starCoin.repairChain();
                    }
                    broadcastLatest();
                    updateNodeInfo();
                    if (options.onChainChange) options.onChainChange();
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
                    if (!starCoin.isChainValid()) {
                        console.warn('🔧 [P2P] 替换链后状态无效，自动修复...');
                        starCoin.repairChain();
                    }
                    broadcastLatest();
                    updateNodeInfo();
                    if (options.onChainChange) options.onChainChange();
                }
            }
        } else {
            console.log(`📥 收到的链不更长（${chain.length} vs ${starCoin.chain.length}），忽略`);
        }
    }

    function handleBlockResponse(block) {
        const latestBlockHeld = starCoin.getLatestBlock();

        if (block.index <= latestBlockHeld.index) {
            if (block.index === latestBlockHeld.index && !starCoin.isChainValid()) {
                console.warn('🔧 [P2P] 收到同索引区块且本地链无效，自动修复...');
                starCoin.repairChain();
            }
            return;
        }

        if (latestBlockHeld.hash === block.previousHash) {
            if (starCoin.addBlock(block)) {
                if (!starCoin.isChainValid()) {
                    console.warn('🔧 [P2P handleBlockResponse] 添加区块后链无效，自动修复...');
                    starCoin.repairChain();
                }
                broadcastLatest();
                updateNodeInfo();
                if (options.onChainChange) options.onChainChange();
            }
        } else {
            console.log('🔄 需要查询完整链');
            broadcastQueryAll();
        }
    }

    function handleNodeInfo(node) {
        if (node.url !== network.nodeInfo.url) {
            network.nodes.add(node.url);
            console.log(`📝 发现新节点: ${node.url}`);
        }
    }

    // ========== 交易池处理（基础层桩方法，供上层 p2p.js 扩展覆盖） ==========

    function handleTransaction(transaction, fromNode) {
        console.log(`📥 [交易] 收到来自 ${fromNode || '某节点'} 的交易: ${transaction.id || 'unknown'}`);
    }

    function handlePendingTxs(transactions, fromNode) {
        if (!Array.isArray(transactions) || transactions.length === 0) return;
        console.log(`📥 [交易池] 收到来自 ${fromNode || '某节点'} 的 ${transactions.length} 笔待打包交易`);
    }

    function handleQueryPendingTxs(ws, fromNode) {
        console.log(`📥 [交易池] 收到来自 ${fromNode || '某节点'} 的交易池请求`);
    }

    // ========== 消息路由分发 ==========
    //
    // 注意：NODE_LIST / NODE_LIST_REQUEST 由上层 (p2p.js) 通过替换 handleMessage 扩展
    // 本层只处理核心区块链业务消息 + 心跳消息

    function handleMessage(ws, message, connectionId) {
        switch (message.type) {
            case MESSAGE_TYPES.QUERY_LATEST:
                network.sendMessage(ws, {
                    type: MESSAGE_TYPES.BLOCK,
                    block: starCoin.getLatestBlock()
                });
                break;
            case MESSAGE_TYPES.QUERY_ALL:
                network.sendMessage(ws, {
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
                network.sendMessage(ws, {
                    type: MESSAGE_TYPES.CHAIN_LENGTH,
                    length: starCoin.chain.length,
                    latestHash: starCoin.getLatestBlock().hash,
                    fromNode: network.nodeInfo.url
                });
                break;
            case MESSAGE_TYPES.SYNC_REQUEST:
                console.log(`🔄 收到来自 ${message.fromNode || '某节点'} 的同步请求，发送完整链`);
                network.sendMessage(ws, {
                    type: MESSAGE_TYPES.CHAIN,
                    chain: starCoin.chain,
                    fromNode: network.nodeInfo.url
                });
                break;
            // ====== 心跳消息处理 ======
            case MESSAGE_TYPES.PING:
                network.sendMessage(ws, { type: MESSAGE_TYPES.PONG });
                break;
            case MESSAGE_TYPES.PONG:
                if (connectionId && network.pendingPongs && network.pendingPongs.has(connectionId)) {
                    clearTimeout(network.pendingPongs.get(connectionId));
                    network.pendingPongs.delete(connectionId);
                }
                break;
            // ====== 交易池广播消息处理 ======
            case MESSAGE_TYPES.TRANSACTION:
                handleTransaction(message.transaction, message.fromNode);
                break;
            case MESSAGE_TYPES.QUERY_PENDING_TXS:
                handleQueryPendingTxs(ws, message.fromNode);
                break;
            case MESSAGE_TYPES.PENDING_TXS:
                handlePendingTxs(message.transactions, message.fromNode);
                break;
        }
    }

    return {
        handleMessage,
        handleChainResponse,
        handleBlockResponse,
        handleNodeInfo,
        handleTransaction,
        handlePendingTxs,
        handleQueryPendingTxs,
        broadcastLatest,
        broadcastQueryAll,
        broadcastNodeInfo,
        broadcastTransaction,
        broadcastPendingTxs,
        updateNodeInfo,
    };
}

module.exports = { createMessageHandlers };