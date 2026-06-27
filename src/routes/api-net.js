// ============================================================
// routes/api-net.js — P2P 同步 + 数据持久化 + 节点连接 + 发现
// ============================================================
const express = require('express');
const { Block } = require('../blockchain');

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

    router.post('/sync', (req, res) => {
        const result = p2p.syncWithPeers();
        res.json({
            ...result,
            valid: starCoin.isChainValid(),
            syncState: p2p.getSyncState()
        });
    });

    router.get('/sync/status', (req, res) => {
        const syncData = p2p.getSyncState();
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
                latestHash: starCoin.getLatestBlock().hash,
                valid: starCoin.isChainValid()
            },
            connectedNodes: p2p.getConnectedCount(),
            peerChains: peerSummary,
            candidates: syncData.candidates.length
        });
    });

    // ============================================================
    // 交易池同步
    // ============================================================

    router.post('/mempool/sync', (req, res) => {
        const result = p2p.syncPendingTxs();
        res.json({
            success: result.success,
            message: result.message,
            poolCount: starCoin.pendingTransactions.length,
            connectedNodes: p2p.getConnectedCount()
        });
    });

    router.post('/mempool/broadcast', (req, res) => {
        const count = starCoin.pendingTransactions.length;
        p2p.broadcastPendingTxs();
        res.json({
            success: true,
            message: `已广播 ${count} 笔待打包交易到对等节点`,
            poolCount: count,
            connectedNodes: p2p.getConnectedCount()
        });
    });

    // ============================================================
    // 数据持久化
    // ============================================================

    router.get('/storage/status', (req, res) => {
        try {
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
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/storage/save', (req, res) => {
        const success = starCoin.saveToFile();
        res.json({
            success: success,
            message: success ? '✅ 区块链已保存到本地文件' : '❌ 保存失败',
            totalBlocks: starCoin.chain.length,
            file: starCoin.dataFile
        });
    });

    router.post('/storage/reload', (req, res) => {
        const success = starCoin.loadFromFile();
        res.json({
            success: success,
            message: success ? '✅ 已从本地文件重新加载区块链' : '⚠️  无法从文件加载（已重建创世区块）',
            totalBlocks: starCoin.chain.length
        });
    });

    router.post('/storage/reset', (req, res) => {
        const success = starCoin.clearDataFile();
        p2p.broadcastLatest();
        res.json({
            success: success,
            message: success ? '🔄 已重置区块链为创世区块状态' : '❌ 重置失败',
            totalBlocks: starCoin.chain.length
        });
    });

    router.get('/storage/export', (req, res) => {
        try {
            const data = {
                chain: starCoin.chain,
                exportedAt: new Date().toISOString(),
                port: PORT,
                version: '1.0'
            };
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="starcoin_chain_${PORT}_${Date.now()}.json"`);
            res.json(data);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/storage/import', (req, res) => {
        try {
            const { chain } = req.body;
            if (!chain || !Array.isArray(chain) || chain.length === 0) {
                return res.status(400).json({ error: '无效的区块链数据' });
            }
            if (!starCoin.isChainValid(chain)) {
                return res.status(400).json({ error: '导入的区块链验证失败' });
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
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ============================================================
    // 节点连接
    // ============================================================

    router.post('/connect', (req, res) => {
        const { peerUrl } = req.body;
        if (!peerUrl) {
            return res.status(400).json({ error: '节点URL不能为空' });
        }
        p2p.connectToPeer(peerUrl);
        res.json({
            success: true,
            message: `正在连接到节点: ${peerUrl}`
        });
    });

    router.post('/disconnect', (req, res) => {
        const { peerUrl } = req.body;
        if (!peerUrl) {
            return res.status(400).json({ error: '节点URL不能为空' });
        }
        const result = p2p.disconnectFromPeer(peerUrl);
        res.json({
            success: result.success,
            message: result.message
        });
    });

    router.get('/nodes', (req, res) => {
        res.json({
            nodes: p2p.getNodeUrls(),
            count: p2p.getConnectedCount(),
            currentNode: p2p.nodeInfo
        });
    });

    router.get('/all-nodes', async (req, res) => {
        const allNodes = await p2p.getAllNodeInfo();
        res.json({
            nodes: allNodes,
            total: allNodes.length
        });
    });

    // ============================================================
    // 自动节点发现
    // ============================================================

    router.get('/discovery/status', (req, res) => {
        res.json({
            success: true,
            discovery: p2p.getDiscoveryStatus()
        });
    });

    router.post('/discovery/start', (req, res) => {
        p2p.startDiscovery();
        res.json({
            success: true,
            message: '✅ 自动节点发现已启动',
            status: p2p.getDiscoveryStatus()
        });
    });

    router.post('/discovery/stop', (req, res) => {
        p2p.stopDiscovery();
        res.json({
            success: true,
            message: '⏸️ 自动节点发现已停止',
            status: p2p.getDiscoveryStatus()
        });
    });

    router.post('/discovery/scan', (req, res) => {
        p2p.requestNodeLists();
        res.json({
            success: true,
            message: '🔍 已发起节点发现扫描',
            status: p2p.getDiscoveryStatus()
        });
    });

    return router;
}

module.exports = createNetRoutes;