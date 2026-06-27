const express = require('express');
const path = require('path');
const http = require('http');
const { Blockchain, Block, Transaction, generateWallet } = require('./blockchain');
const { createP2P } = require('./p2p');

const app = express();
const PORT = process.env.PORT || 3000;

// 初始化区块链
const starCoin = new Blockchain();

// 创建 HTTP 服务器
const server = http.createServer(app);

// 初始化 P2P 网络层
const p2p = createP2P(server, starCoin, PORT);

// 静态文件服务
app.use(express.static(path.join(__dirname, '..', 'public')));
// 同时提供 src/ 目录下的 JS 文件的访问
app.use('/src', express.static(path.join(__dirname, '..', 'src')));
app.use(express.json());

// API 路由
app.get('/api/blockchain', (req, res) => {
    res.json({
        chain: starCoin.chain,
        isValid: starCoin.isChainValid(),
        stats: {
            totalBlocks: starCoin.chain.length,
            difficulty: starCoin.difficulty,
            genesisBlock: starCoin.chain[0].hash.substring(0, 16) + '...',
            connectedNodes: p2p.getConnectedCount()
        },
        port: PORT,
        nodeInfo: p2p.nodeInfo
    });
});

// ============================================================
// 交易相关 API
// ============================================================

// 1. 创建新钱包（生成地址和私钥）
app.post('/api/wallet/new', (req, res) => {
    const wallet = generateWallet();
    res.json({
        success: true,
        wallet: wallet
    });
});

// 2. 提交一笔转账到交易池（需要 ECDSA 签名）
app.post('/api/transaction', (req, res) => {
    try {
        const { from, to, amount, fee, note, privateKey, publicKey } = req.body;
        if (!from || !to || !amount) {
            return res.status(400).json({
                success: false,
                error: '必须提供 from, to, amount 字段'
            });
        }
        if (!privateKey || !publicKey) {
            return res.status(400).json({
                success: false,
                error: '必须提供 privateKey 和 publicKey 用于 ECDSA 签名。请先用 POST /api/wallet/new 生成钱包。'
            });
        }
        const tx = new Transaction(from, to, Number(amount), Number(fee) || 0, note || '');
        tx.signTransaction(privateKey, publicKey);
        const savedTx = starCoin.addTransaction(tx);
        res.json({
            success: true,
            message: '交易已通过 ECDSA 签名验证，已加入交易池',
            transaction: savedTx,
            poolCount: starCoin.pendingTransactions.length
        });
    } catch (err) {
        res.status(400).json({
            success: false,
            error: err.message
        });
    }
});

// 3. 查询地址余额
app.get('/api/balance/:address', (req, res) => {
    const address = req.params.address;
    const balance = starCoin.getBalance(address);
    const pendingInPool = starCoin.pendingTransactions
        .filter(tx => tx.from === address || tx.to === address)
        .length;
    res.json({
        success: true,
        address: address,
        balance: balance,
        pendingTransactions: pendingInPool,
        historyCount: starCoin.getTransactionHistory(address).length
    });
});

// 4. 查询地址交易历史
app.get('/api/transactions/:address', (req, res) => {
    const history = starCoin.getTransactionHistory(req.params.address);
    res.json({
        success: true,
        address: req.params.address,
        total: history.length,
        transactions: history
    });
});

// 5. 查看交易池 (Mempool)
app.get('/api/mempool', (req, res) => {
    res.json({
        success: true,
        count: starCoin.pendingTransactions.length,
        transactions: starCoin.pendingTransactions
    });
});

// 6. 清空交易池
app.delete('/api/mempool', (req, res) => {
    const count = starCoin.pendingTransactions.length;
    starCoin.pendingTransactions = [];
    res.json({
        success: true,
        message: `已清空 ${count} 笔待打包交易`,
        cleared: count
    });
});

// 7. 所有地址排行榜
app.get('/api/addresses', (req, res) => {
    const addresses = starCoin.getAllAddresses();
    res.json({
        success: true,
        total: addresses.length,
        addresses: addresses
    });
});

// 8. 挖矿（从交易池打包交易）
app.post('/api/mine', (req, res) => {
    const { minerAddress, data } = req.body;
    const startTime = Date.now();
    try {
        const newBlock = starCoin.mineBlock(minerAddress || starCoin.miningAddress, data);
        const miningTime = Date.now() - startTime;

        // 广播新区块到其他节点
        p2p.broadcastLatest();
        p2p.updateNodeInfo();

        res.json({
            success: true,
            block: newBlock,
            transactionCount: newBlock.transactions.length,
            reward: starCoin.miningReward,
            miningTime: miningTime + 'ms'
        });
    } catch (err) {
        res.status(400).json({
            success: false,
            error: err.message
        });
    }
});

app.get('/api/validate', (req, res) => {
    res.json({
        success: true,
        isValid: starCoin.isChainValid(),
        totalBlocks: starCoin.chain.length
    });
});

// ============ 节点同步 API ============

app.post('/api/sync', (req, res) => {
    const result = p2p.syncWithPeers();
    res.json({
        ...result,
        valid: starCoin.isChainValid(),
        syncState: p2p.getSyncState()
    });
});

app.get('/api/sync/status', (req, res) => {
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

// ============ 数据持久化 API ============

app.get('/api/storage/status', (req, res) => {
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

app.post('/api/storage/save', (req, res) => {
    const success = starCoin.saveToFile();
    res.json({
        success: success,
        message: success ? '✅ 区块链已保存到本地文件' : '❌ 保存失败',
        totalBlocks: starCoin.chain.length,
        file: starCoin.dataFile
    });
});

app.post('/api/storage/reload', (req, res) => {
    const success = starCoin.loadFromFile();
    res.json({
        success: success,
        message: success ? '✅ 已从本地文件重新加载区块链' : '⚠️  无法从文件加载（已重建创世区块）',
        totalBlocks: starCoin.chain.length
    });
});

app.post('/api/storage/reset', (req, res) => {
    const success = starCoin.clearDataFile();
    p2p.broadcastLatest();
    res.json({
        success: success,
        message: success ? '🔄 已重置区块链为创世区块状态' : '❌ 重置失败',
        totalBlocks: starCoin.chain.length
    });
});

app.get('/api/storage/export', (req, res) => {
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

app.post('/api/storage/import', (req, res) => {
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

app.post('/api/connect', (req, res) => {
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

app.post('/api/disconnect', (req, res) => {
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

app.get('/api/nodes', (req, res) => {
    res.json({
        nodes: p2p.getNodeUrls(),
        count: p2p.getConnectedCount(),
        currentNode: p2p.nodeInfo
    });
});

app.get('/api/all-nodes', async (req, res) => {
    const allNodes = await p2p.getAllNodeInfo();
    res.json({
        nodes: allNodes,
        total: allNodes.length
    });
});

// 主页路由
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// 启动服务器
server.listen(PORT, () => {
    console.log(`🚀 StarCoin 服务器运行在 http://localhost:${PORT}`);
    console.log(`📊 初始区块链已创建，包含 ${starCoin.chain.length} 个区块`);
    console.log(`🆔 节点ID: ${p2p.nodeInfo.id}`);

    // 自动连接到对等节点（如果是第二个节点）
    if (PORT !== 3000) {
        setTimeout(() => {
            p2p.connectToPeer(`ws://localhost:3000`);
            setTimeout(() => {
                console.log('🔄 启动后首次同步...');
                p2p.syncWithPeers();
            }, 3000);
        }, 1000);
    } else {
        setTimeout(() => {
            if (p2p.getConnectedCount() > 0) {
                console.log('🔄 主节点启动后同步检查...');
                p2p.syncWithPeers();
            }
        }, 5000);
    }

    // 每 60 秒自动同步一次
    setInterval(() => {
        if (p2p.getConnectedCount() > 0) {
            console.log('⏰ 定期自动同步...');
            p2p.syncWithPeers();
        }
    }, 60000);
});

// 导出用于测试
module.exports = { starCoin, Blockchain, Block, Transaction, generateWallet };