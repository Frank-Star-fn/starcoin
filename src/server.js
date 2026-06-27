const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { Blockchain, Block, Transaction, generateWallet, importWalletFromPem } = require('./blockchain');
const { createP2P } = require('./p2p/p2p');
const createRoutes = require('./routes');

const app = express();
const PORT = process.env.PORT || 3000;

// 初始化区块链
const starCoin = new Blockchain();

// 创建 HTTP 服务器
const server = http.createServer(app);

// ============================================================
// 前端 WebSocket 推送服务（与 P2P 共享同一 WebSocket 服务器）
// 通过 URL 路径区分: 前端连接 /ws, P2P 节点连接 /
// ============================================================
const frontendClients = new Set();

/**
 * 向所有已连接的前端客户端广播消息
 * @param {string} type - 消息类型: 'newBlock' | 'newTransaction' | 'chainUpdated'
 * @param {object} data - 附加数据
 */
function broadcastToFrontend(type, data = {}) {
    const message = JSON.stringify({ type, ...data, timestamp: Date.now() });
    frontendClients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        } else {
            frontendClients.delete(client);
        }
    });
}

// 初始化 P2P 网络层（传入 frontendConnection 回调，由 P2P 层代为处理前端 WS 连接）
const p2p = createP2P(server, starCoin, PORT, {
    onFrontendConnection: (ws) => {
        frontendClients.add(ws);
        console.log(`🎯 前端客户端已连接，当前连接数: ${frontendClients.size}`);

        ws.on('close', () => {
            frontendClients.delete(ws);
            console.log(`🔌 前端客户端已断开，剩余连接数: ${frontendClients.size}`);
        });

        ws.on('error', (err) => {
            frontendClients.delete(ws);
            console.error('❌ 前端 WebSocket 错误:', err.message);
        });
    },
    onChainChange: () => {
        broadcastToFrontend('chainUpdated');
    }
});

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
            targetBlockTime: starCoin.targetBlockTime,
            difficultyHistory: starCoin.difficultyHistory.slice(-10), // 最近10次调整
            genesisBlock: starCoin.chain[0].hash.substring(0, 16) + '...',
            connectedNodes: p2p.getConnectedCount(),
            totalBurnedFees: starCoin.getTotalBurnedFees(),
            recentBurnedFees: starCoin.getRecentBurnedFees(20)
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

// 1b. 从 PEM 私钥导入钱包（恢复地址和公钥）
app.post('/api/wallet/import', (req, res) => {
    try {
        const { privateKeyPem } = req.body;
        if (!privateKeyPem) {
            return res.status(400).json({
                success: false,
                error: '必须提供 privateKeyPem 字段（PEM 格式私钥）'
            });
        }
        const wallet = importWalletFromPem(privateKeyPem);
        res.json({
            success: true,
            message: '✅ 私钥有效，已恢复钱包',
            wallet: wallet
        });
    } catch (err) {
        res.status(400).json({
            success: false,
            error: '私钥导入失败: ' + err.message
        });
    }
});

// 1c. 验证 PEM 私钥是否有效（仅验证，不返回完整私钥
app.post('/api/wallet/verify-pem', (req, res) => {
    try {
        const { privateKeyPem } = req.body;
        if (!privateKeyPem) {
            return res.status(400).json({
                success: false,
                error: '必须提供 privateKeyPem 字段'
            });
        }
        const wallet = importWalletFromPem(privateKeyPem);
        res.json({
            success: true,
            message: '✅ PEM 格式有效',
            publicKey: wallet.publicKey,
            address: wallet.address
        });
    } catch (err) {
        res.status(400).json({
            success: false,
            error: 'PEM 验证失败: ' + err.message
        });
    }
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
        // WebSocket 推送：新区交易到达
        broadcastToFrontend('newTransaction', {
            poolCount: starCoin.pendingTransactions.length,
            txId: savedTx.id
        });
        // P2P 广播：将交易广播到其他节点
        p2p.broadcastTransaction(savedTx);
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
    const balance = starCoin.getBalance(address);               // 可用余额（已剔除未成熟奖励）
    const totalBalance = starCoin.getBalance(address, true);    // 总余额（含未成熟奖励）
    const lockedRewards = starCoin.getLockedRewards(address);
    const pendingInPool = starCoin.pendingTransactions
        .filter(tx => tx.from === address || tx.to === address)
        .length;
    res.json({
        success: true,
        address: address,
        balance: balance,
        totalBalance: totalBalance,
        lockedRewards: lockedRewards,
        coinbaseMaturity: starCoin.coinbaseMaturity,
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
        // 广播更新后的交易池（通知其他节点哪些交易已被打包）
        p2p.broadcastPendingTxs();
        p2p.updateNodeInfo();

        // WebSocket 推送：新区块诞生
        broadcastToFrontend('newBlock', {
            blockIndex: newBlock.index,
            blockHash: newBlock.hash,
            transactionCount: newBlock.transactions.length,
            difficulty: starCoin.difficulty
        });

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

// 8b. SSE 挖矿进度流（带可视化动画）
app.get('/api/mine/stream', async (req, res) => {
    const minerAddress = req.query.minerAddress || starCoin.miningAddress;

    // 设置 SSE 响应头
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    // 持续挖矿标志：当中止时自动重启
    let keepMining = true;
    let consecutiveCancels = 0;

    // ★ 修复：监听客户端断开连接，及时中止后台挖矿，防止孤立挖矿进程堆积
    let clientDisconnected = false;
    req.on('close', () => {
        clientDisconnected = true;
        keepMining = false;
    });

    while (keepMining && !clientDisconnected) {
        const diffInfo = Block._parseDifficulty(starCoin.difficulty);
        const chainLength = starCoin.chain.length;
        res.write(`data: ${JSON.stringify({
            nonce: 0, hash: '', target: diffInfo.targetText,
            difficulty: starCoin.difficulty,
            found: false, started: true,
            chainLength: chainLength,
            message: '⛏️ 开始挖矿... (难度=' + starCoin.difficulty + ', 目标=' + diffInfo.targetText + ', 高度=' + chainLength + ')'
        })}\n\n`);

        try {
            // 异步挖矿，每找到一批 nonce 就回调推送进度
            const result = await starCoin.mineBlockAsync(minerAddress, null, (progress) => {
                // 如果挖矿过程中检测到链更新，在进度中通知前端
                if (progress.aborted) {
                    res.write(`data: ${JSON.stringify({
                        ...progress,
                        message: '🔄 检测到区块链更新，正在切换到新链...'
                    })}\n\n`);
                } else {
                    res.write(`data: ${JSON.stringify(progress)}\n\n`);
                }
            }, () => clientDisconnected);  // ★ 修复：传递客户端断开检测

            // 如果挖矿被取消（链已更新 或 客户端断开），自动处理
            if (result && result.canceled) {
                // ★ 修复：客户端已断开，直接退出
                if (clientDisconnected) {
                    keepMining = false;
                    break;
                }
                consecutiveCancels++;
                // 防止无限循环：如果连续取消超过 20 次，放弃
                if (consecutiveCancels > 20) {
                    res.write(`data: ${JSON.stringify({
                        found: false,
                        error: '链频繁更新，已放弃挖矿',
                        message: '❌ 链频繁更新，已放弃挖矿'
                    })}\n\n`);
                    keepMining = false;
                    break;
                }
                console.log(`🔄 [SSE挖矿] 链已更新，自动在新链上重新开始挖矿（第 ${consecutiveCancels} 次取消）`);
                // 发送链更新通知，然后继续循环
                res.write(`data: ${JSON.stringify({
                    chainUpdated: true,
                    newChainLength: starCoin.chain.length,
                    difficulty: starCoin.difficulty,
                    message: '🔄 区块链已更新（高度=' + starCoin.chain.length + '），自动切换到新链继续挖矿...'
                })}\n\n`);
                continue; // 回到循环开始，在新链上重启挖矿
            }

            // 正常挖矿成功，重置取消计数
            consecutiveCancels = 0;

            // 挖矿完成，广播到其他节点
            p2p.broadcastLatest();
            // 广播更新后的交易池（通知其他节点哪些交易已被打包）
            p2p.broadcastPendingTxs();
            p2p.updateNodeInfo();

            // WebSocket 推送：新区块诞生（SSE 挖矿路径）
            broadcastToFrontend('newBlock', {
                blockIndex: result.index,
                blockHash: result.hash,
                transactionCount: result.transactions.length,
                difficulty: starCoin.difficulty,
                source: 'sse-mining'
            });

            // 发送最终结果
            res.write(`data: ${JSON.stringify({
                found: true,
                nonce: result.nonce,
                hash: result.hash,
                difficulty: starCoin.difficulty,
                block: {
                    index: result.index,
                    hash: result.hash,
                    previousHash: result.previousHash,
                    nonce: result.nonce,
                    timestamp: result.timestamp,
                    transactionCount: result.transactions.length
                },
                reward: starCoin.miningReward,
                message: '🎉 挖矿成功！区块 #' + result.index + ' 已生成'
            })}\n\n`);

            keepMining = false; // 只在挖矿成功时退出循环
        } catch (err) {
            if (!clientDisconnected) {
                res.write(`data: ${JSON.stringify({
                    found: false,
                    error: err.message,
                    message: '❌ ' + err.message
                })}\n\n`);
            }
            keepMining = false;
        }
    }

    if (!clientDisconnected) {
        res.end();
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

// ============ 交易池同步 API ============

// 手动触发生交池同步
app.post('/api/mempool/sync', (req, res) => {
    const result = p2p.syncPendingTxs();
    res.json({
        success: result.success,
        message: result.message,
        poolCount: starCoin.pendingTransactions.length,
        connectedNodes: p2p.getConnectedCount()
    });
});

// 手动广播本地交易池
app.post('/api/mempool/broadcast', (req, res) => {
    const count = starCoin.pendingTransactions.length;
    p2p.broadcastPendingTxs();
    res.json({
        success: true,
        message: `已广播 ${count} 笔待打包交易到对等节点`,
        poolCount: count,
        connectedNodes: p2p.getConnectedCount()
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

// ============ 自动节点发现 API ============

// 获取自动发现状态
app.get('/api/discovery/status', (req, res) => {
    res.json({
        success: true,
        discovery: p2p.getDiscoveryStatus()
    });
});

// 启动自动发现
app.post('/api/discovery/start', (req, res) => {
    p2p.startDiscovery();
    res.json({
        success: true,
        message: '✅ 自动节点发现已启动',
        status: p2p.getDiscoveryStatus()
    });
});

// 停止自动发现
app.post('/api/discovery/stop', (req, res) => {
    p2p.stopDiscovery();
    res.json({
        success: true,
        message: '⏸️ 自动节点发现已停止',
        status: p2p.getDiscoveryStatus()
    });
});

// 手动触发一次节点发现
app.post('/api/discovery/scan', (req, res) => {
    p2p.requestNodeLists();
    res.json({
        success: true,
        message: '🔍 已发起节点发现扫描',
        status: p2p.getDiscoveryStatus()
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

    // ---------- 种子节点发现与启动同步 ----------
    // 从环境变量 SEED_PEERS 获取种子节点列表（逗号分隔），
    // 例如: SEED_PEERS="ws://localhost:3000,ws://localhost:3001"
    const seedPeers = (process.env.SEED_PEERS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    // 如果是全新启动（无本地数据），优先从其他节点获取链
    if (starCoin.freshStart) {
        console.log('🆕 检测到全新节点（无本地数据），将优先从其他节点同步区块链...');
        if (seedPeers.length === 0) {
            // 未配置 SEED_PEERS 时，默认尝试连接其他常见端口
            const commonPorts = ['3000', '3001', '3002', '3003', '3004'];
            for (const p of commonPorts) {
                if (p !== PORT) {
                    seedPeers.push(`ws://localhost:${p}`);
                }
            }
        }
    } else {
        // 有本地数据，但仍尝试连接已配置的种子节点
        if (seedPeers.length === 0) {
            // 如果本地有数据且非 3000 端口，默认尝试连接 3000 同步
            if (PORT !== '3000') {
                seedPeers.push('ws://localhost:3000');
            }
        }
    }

    // 连接种子节点并执行首次同步
    if (seedPeers.length > 0) {
        console.log(`🔗 将尝试连接 ${seedPeers.length} 个种子节点: ${seedPeers.join(', ')}`);
        setTimeout(() => {
            let connected = 0;
            for (const peerUrl of seedPeers) {
                try {
                    p2p.connectToPeer(peerUrl);
                    connected++;
                } catch (e) {
                    // 连接失败静默处理
                }
            }
            // 等待连接建立后同步
            const syncDelay = starCoin.freshStart ? 5000 : 3000;
            setTimeout(() => {
                console.log('🔄 启动后首次同步...');
                const result = p2p.syncWithPeers();
                if (starCoin.freshStart) {
                    // 同步完成后检查是否获取到了数据
                    setTimeout(() => {
                        if (starCoin.chain.length <= 1) {
                            console.log('ℹ️  未从其他节点获取到区块链数据，将使用本地创世区块开始新链');
                        } else {
                            console.log(`✅ 已从其他节点同步区块链，当前链长度: ${starCoin.chain.length}`);
                        }
                    }, 12000); // 等待同步超时 + 缓冲
                }
            }, syncDelay);
        }, 1500);
    } else {
        // 没有种子节点，仅对非 3000 节点保持向后兼容
        if (PORT !== '3000') {
            setTimeout(() => {
                p2p.connectToPeer('ws://localhost:3000');
                setTimeout(() => {
                    console.log('🔄 启动后首次同步...');
                    p2p.syncWithPeers();
                }, 3000);
            }, 1000);
        }
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
module.exports = { starCoin, Blockchain, Block, Transaction, generateWallet, importWalletFromPem };