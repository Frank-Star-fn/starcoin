const { MESSAGE_TYPES } = require('./p2p-core');
const logger = require('../logger');
const config = require('../config');
const { settle } = require('./settle');
const { createChainSync } = require('./chain-sync');
const { createPendingSync } = require('./pending-sync');

/** 区块链业务消息处理：链同步、区块追加、交易池等，与 p2p-core 网络层解耦 */
function createMessageHandlers(network, starCoin, options = {}) {
    const log = logger.module('P2P-Handlers');
    let handlers;
    const sync = createChainSync(network, starCoin, {
        onChain: (chain, ws, requestId) => handlers.handleChainResponse(chain, network.peerUrl?.(ws), ws, requestId),
        onProgress: options.onSyncProgress,
        onFailure: options.onSyncFailure
    });

    const pendingSync = createPendingSync(network, starCoin,
        (transactions, fromNode) => (options.onPendingTransactions || handlePendingTxs)(transactions, fromNode), sync.active);

    // 业务广播（封装网络层的 broadcast）

    function broadcastLatest() {
        if (Buffer.byteLength(JSON.stringify({ type: MESSAGE_TYPES.BLOCK, block: starCoin.getLatestBlock() }), 'utf8') > config.P2P_MAX_PAYLOAD) {
            // Large blocks use the same bounded download path as historical blocks.
            network.broadcast({ type: MESSAGE_TYPES.CHAIN_SUMMARY, length: starCoin.chain.length,
                latestHash: starCoin.getLatestBlock().hash, ancestor: null });
            return;
        }
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
        const message = {
            type: MESSAGE_TYPES.TRANSACTION,
            transaction: tx,
            fromNode: network.nodeInfo.url
        };
        if (Buffer.byteLength(JSON.stringify(message), 'utf8') > config.P2P_MAX_PAYLOAD) return;
        network.broadcast(message);
    }

    /**
     * 向所有已连接节点广播本节点的待打包交易列表
     */
    function broadcastPendingTxs() {
        pendingSync.broadcast();
    }

    /** 更新节点信息中的链状态 */
    function updateNodeInfo() {
        network.nodeInfo.chainLength = starCoin.chain.length;
        network.nodeInfo.chainWork = starCoin.getChainWork().toString();
        network.nodeInfo.consensusHash = starCoin.consensus.fingerprint;
        network.nodeInfo.lastUpdated = new Date().toISOString();
    }

    // 链/区块消息处理

    function notifyChainChange() {
        broadcastLatest();
        updateNodeInfo();
        if (options.onChainChange) options.onChainChange();
    }

    function handleChainResponse(chain, fromNode) {
        if (!Array.isArray(chain) || !chain.length) return;
        if (chain.length === 1 && chain[0].index !== 0) {
            return handleBlockResponse(chain[0]);
        }
        // replaceChain validates all blocks and compares locally computed work.
        return settle(starCoin.replaceChain(chain), accepted => { if (accepted) notifyChainChange(); });
    }

    function handleBlockResponse(block, ws) {
        if (!block || typeof block.hash !== 'string') return;
        const latest = starCoin.getLatestBlock();
        if (block.hash === latest.hash) return;
        if (block.previousHash === latest.hash) {
            return settle(starCoin.addBlock(block), accepted => { if (accepted) notifyChainChange(); });
        } else {
            // A shorter/equal-height branch may have more work. Ask for its proof.
            if (ws) { if (!sync.active(ws)) sync.request(ws); }
            else broadcastQueryAll();
        }
    }

    function handleNodeInfo(node) {
        if (node.url !== network.nodeInfo.url) {
            network.nodes.add(node.url);
            log.info('发现新节点', { url: node.url });
        }
    }

    // 交易池处理（基础桩方法，可被上层 p2p.js 覆盖）

    function handleTransaction(transaction, fromNode) {
        log.info('收到交易', { fromNode, txId: transaction.id });
    }

    function handlePendingTxs(transactions, fromNode) {
        if (!Array.isArray(transactions) || transactions.length === 0) return;
        log.info('收到待打包交易列表', { fromNode, count: transactions.length });
    }

    function handleQueryPendingTxs(ws, fromNode) {
        log.info('收到交易池请求', { fromNode });
    }

    // 消息路由分发（NODE_LIST 由上层 p2p.js 扩展）
    function handleMessage(ws, message, connectionId) {
        switch (message.type) {
            case MESSAGE_TYPES.QUERY_LATEST:
                if (Buffer.byteLength(JSON.stringify({ type: MESSAGE_TYPES.BLOCK, block: starCoin.getLatestBlock() }), 'utf8') > config.P2P_MAX_PAYLOAD) {
                    sync.summary(ws);
                    break;
                }
                network.sendMessage(ws, {
                    type: MESSAGE_TYPES.BLOCK,
                    block: starCoin.getLatestBlock()
                });
                break;
            case MESSAGE_TYPES.QUERY_ALL:
            case MESSAGE_TYPES.SYNC_REQUEST:
            case MESSAGE_TYPES.CHAIN_SUMMARY:
            case MESSAGE_TYPES.QUERY_BLOCKS:
            case MESSAGE_TYPES.BLOCKS:
            case MESSAGE_TYPES.SYNC_RESTART:
                return sync.handle(ws, message);
            case MESSAGE_TYPES.CHAIN:
                return handleChainResponse(message.chain, message.fromNode);
            case MESSAGE_TYPES.BLOCK:
                return handleBlockResponse(message.block, ws);
            case MESSAGE_TYPES.NODE_INFO:
                handleNodeInfo(message.node);
                break;
            case MESSAGE_TYPES.CHAIN_LENGTH:
                if (message.length !== undefined) break;
                network.sendMessage(ws, {
                    type: MESSAGE_TYPES.CHAIN_LENGTH,
                    length: starCoin.chain.length,
                    chainWork: starCoin.getChainWork().toString(),
                    latestHash: starCoin.getLatestBlock().hash,
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
                return pendingSync.reply(ws, message);
            case MESSAGE_TYPES.PENDING_TXS:
                return pendingSync.receive(ws, message);
        }
    }

    handlers = {
        sendPendingTxs: pendingSync.reply,
        receivePendingTxs: pendingSync.receive,
        requestSync: sync.request,
        cancelSync: sync.cancel,
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
    return handlers;
}

module.exports = { createMessageHandlers };
