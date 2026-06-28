// ============================================================
// routes/api-net.js — P2P 同步 + 数据持久化 + 节点连接 + 发现
// ============================================================
const express = require('express');
const { Block } = require('../blockchain');
const { AppError, wrapAsync } = require('./error-handler');

/**
 * 创建网络层相关的路由
 * @param {object} starCoin  - Blockchain 实例
 * @param {object} p2p       - P2P 网络层实例
 * @param {string|number} PORT - 当前服务器端口号
 * @returns {express.Router}
 */
function createNetRoutes(starCoin, p2p, PORT) {
    const router = express.Router();

    // ============================================================
    // 节点同步
    // ============================================================

    router.post('/sync', wrapAsync(async (req, res) => {
        const result = p2p.syncWithPeers();
        res.json({
            ...result,
            valid: starCoin.isChainValid(),
            syncState: p2p.getSyncState()
        });
    }));

    router.get('/sync/status', wrapAsync(async (req, res) => {
        const syncData = p2p.getSyncState();
        const latestBlock = starCoin.getLatestBlock();
        // 确保有最新区块（创世区块必须存在）
        if (!latestBlock || !latestBlock.hash) {
            throw new AppError(500, '区块链状态异常：无法获取最新区块', 'CHAIN_CORRUPTED');
        }
        const peerSummary = syncData.candidates.map(c => ({
            node: c.fromNode,
            length: c.length,
            valid: c.valid
        }));

        res.json({
            success: true,
            isSyncing: syncData.isSyncing,
            lastSyncAt: syncData.lastSyncAt,
            selfChain: {
                length: starCoin.chain.length,
                latestHash: latestBlock.hash,
                valid: starCoin.isChainValid()
            },
            connectedNodes: p2p.getConnectedCount(),
            peerChains: peerSummary,
            candidates: syncData.candidates.length
        });
    }));

    // ============================================================
    // 交易池同步
    // ============================================================

    router.post('/mempool/sync', wrapAsync(async (req, res) => {
        const result = p2p.syncPendingTxs();
        if (!result || !result.success) {
            throw new AppError(502, '交易池同步失败: ' + (result && result.message ? result.message : '对等节点无响应'), 'SYNC_FAILED');
        }
        res.json({
            success: result.success,
            message: result.message,
            poolCount: starCoin.pendingTransactions.length,
            connectedNodes: p2p.getConnectedCount()
        });
    }));

    router.post('/mempool/broadcast', wrapAsync(async (req, res) => {
        const count = starCoin.pendingTransactions.length;
        if (count === 0) {
            return res.json({
                success: true,
                message: '交易池为空，没有可广播的交易',
                poolCount: 0,
                connectedNodes: p2p.getConnectedCount()
            });
        }
        p2p.broadcastPendingTxs();
        res.json({
            success: true,
            message: `已广播 ${count} 笔待打包交易到对等节点`,
            poolCount: count,
            connectedNodes: p2p.getConnectedCount()
        });
    }));

    // ============================================================
    // 数据持久化
    // ============================================================

    router.get('/storage/status', wrapAsync(async (req, res) => {
        const fs = require('fs');
        const filePath = starCoin.dataFile;
        const exists = fs.existsSync(filePath);
        let fileSize = 0;
        let lastModified = null;
        if (exists) {
            const stats = fs.statSync(filePath);
            fileSize = stats.size;
            lastModified = stats.mtime.toISOString();
        }
        res.json({
            enabled: true,
            file: filePath,
            exists: exists,
            size: fileSize,
            sizeKB: (fileSize / 1024).toFixed(2),
            lastModified: lastModified,
            totalBlocks: starCoin.chain.length
        });
    }));

    router.post('/storage/save', wrapAsync(async (req, res) => {
        const success = starCoin.saveToFile();
        if (!success) {
            throw new AppError(500, '区块链保存到本地文件失败', 'SAVE_FAILED');
        }
        res.json({
            success: true,
            message: '✅ 区块链已保存到本地文件',
            totalBlocks: starCoin.chain.length,
            file: starCoin.dataFile
        });
    }));

    router.post('/storage/reload', wrapAsync(async (req, res) => {
        const success = starCoin.loadFromFile();
        // loadFromFile 返回 false 时表示文件不存在或不完整，已重建创世区块，不算严重错误
        res.json({
            success: success,
            message: success ? '✅ 已从本地文件重新加载区块链' : '⚠️  无法从文件加载（已重建创世区块）',
            totalBlocks: starCoin.chain.length
        });
    }));

    router.post('/storage/reset', wrapAsync(async (req, res) => {
        const success = starCoin.clearDataFile();
        if (!success) {
            throw new AppError(500, '重置区块链失败', 'RESET_FAILED');
        }
        p2p.broadcastLatest();
        res.json({
            success: true,
            message: '🔄 已重置区块链为创世区块状态',
            totalBlocks: starCoin.chain.length
        });
    }));

    router.get('/storage/export', wrapAsync(async (req, res) => {
        if (!starCoin.chain || starCoin.chain.length === 0) {
            throw new AppError(500, '区块链为空，无法导出', 'CHAIN_EMPTY');
        }
        const data = {
            chain: starCoin.chain,
            exportedAt: new Date().toISOString(),
            port: PORT,
            version: '1.0'
        };
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="starcoin_chain_${PORT}_${Date.now()}.json"`);
        res.json(data);
    }));

    router.post('/storage/import', wrapAsync(async (req, res) => {
        const { chain } = req.body;
        if (!chain || !Array.isArray(chain) || chain.length === 0) {
            throw new AppError(400, '无效的区块链数据：必须提供非空的 chain 数组', 'INVALID_CHAIN_DATA');
        }
        if (!starCoin.isChainValid(chain)) {
            throw new AppError(400, '导入的区块链验证失败：数据不完整或哈希不匹配', 'CHAIN_VALIDATION_FAILED');
        }
        starCoin.chain = chain.map(b => {
            const txSrc = b.transactions || (b.data ? b.data : []);
            const block = new Block(b.index, b.timestamp, txSrc, b.previousHash);
            block.nonce = b.nonce;
            block.hash = b.hash;
            return block;
        });
        starCoin.saveToFile();
        p2p.broadcastLatest();
        res.json({
            success: true,
            message: `✅ 已导入 ${chain.length} 个区块`,
            totalBlocks: starCoin.chain.length
        });
    }));

    // ============================================================
    // 节点连接
    // ============================================================

    router.post('/connect', wrapAsync(async (req, res) => {
        const { peerUrl } = req.body;
        if (!peerUrl) {
            throw new AppError(400, '节点URL不能为空', 'MISSING_PARAM');
        }
        // 校验 URL 格式
        try {
            new URL(peerUrl);
        } catch (_) {
            throw new AppError(400, '节点URL格式无效，请使用 ws://host:port 格式', 'INVALID_URL');
        }
        p2p.connectToPeer(peerUrl);
        res.json({
            success: true,
            message: `正在连接到节点: ${peerUrl}`
        });
    }));

    router.post('/disconnect', wrapAsync(async (req, res) => {
        const { peerUrl } = req.body;
        if (!peerUrl) {
            throw new AppError(400, '节点URL不能为空', 'MISSING_PARAM');
        }
        const result = p2p.disconnectFromPeer(peerUrl);
        if (!result.success) {
            throw new AppError(404, result.message || '未找到该节点连接', 'PEER_NOT_FOUND');
        }
        res.json({
            success: true,
            message: result.message
        });
    }));

    router.get('/nodes', wrapAsync(async (req, res) => {
        res.json({
            nodes: p2p.getNodeUrls(),
            count: p2p.getConnectedCount(),
            currentNode: p2p.nodeInfo
        });
    }));

    router.get('/all-nodes', wrapAsync(async (req, res) => {
        const allNodes = await p2p.getAllNodeInfo();
        res.json({
            nodes: allNodes,
            total: allNodes.length
        });
    }));

    // ============================================================
    // 自动节点发现
    // ============================================================

    router.get('/discovery/status', wrapAsync(async (req, res) => {
        const status = p2p.getDiscoveryStatus();
        if (!status) {
            throw new AppError(500, '无法获取节点发现状态', 'DISCOVERY_STATUS_FAILED');
        }
        res.json({
            success: true,
            discovery: status
        });
    }));

    router.post('/discovery/start', wrapAsync(async (req, res) => {
        p2p.startDiscovery();
        res.json({
            success: true,
            message: '✅ 自动节点发现已启动',
            status: p2p.getDiscoveryStatus()
        });
    }));

    router.post('/discovery/stop', wrapAsync(async (req, res) => {
        p2p.stopDiscovery();
        res.json({
            success: true,
            message: '⏸️ 自动节点发现已停止',
            status: p2p.getDiscoveryStatus()
        });
    }));

    router.post('/discovery/scan', wrapAsync(async (req, res) => {
        p2p.requestNodeLists();
        res.json({
            success: true,
            message: '🔍 已发起节点发现扫描',
            status: p2p.getDiscoveryStatus()
        });
    }));

    return router;
}

module.exports = createNetRoutes;