// ============================================================
// routes.js — StarCoin 所有 API 路由定义
//
// 使用方式 (在 server.js 中):
//   const createRoutes = require('./routes');
//   app.use(createRoutes(starCoin, p2p, broadcastToFrontend, PORT));
// ============================================================
const express = require('express');
const { Block, Transaction, generateWallet, importWalletFromPrivateKey } = require('./blockchain');

/**
 * 创建并返回一个 Express Router，挂载所有 API 路由
 * @param {object} starCoin               - Blockchain 实例（共享状态）
 * @param {object} p2p                    - P2P 网络层实例
 * @param {function} broadcastToFrontend  - WebSocket 广播函数
 * @param {string|number} PORT            - 当前服务器端口号
 * @returns {express.Router}
 */
function createRoutes(starCoin, p2p, broadcastToFrontend, PORT) {
    const router = express.Router();

    // ============================================================
    // 区块链信息
    // ============================================================
    router.get('/api/blockchain', (req, res) => {
        res.json({
            chain: starCoin.chain,
            isValid: starCoin.isChainValid(),
            stats: {
                totalBlocks: starCoin.chain.length,
                difficulty: starCoin.difficulty,
                targetBlockTime: starCoin.targetBlockTime,
                difficultyHistory: starCoin.difficultyHistory.slice(-10),
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
    router.post('/api/wallet/new', (req, res) => {
        const wallet = generateWallet();
        res.json({
            success: true,
            wallet: wallet
        });
    });

    // 1b. 导入已有私钥（PEM格式），推导出公钥和地址
    router.post('/api/wallet/import', (req, res) => {
        try {
            const { privateKey } = req.body;
            if (!privateKey || !privateKey.includes('BEGIN PRIVATE KEY')) {
                return res.status(400).json({
                    success: false,
                    error: '必须提供有效的 PEM 格式私钥（PKCS#8）'
                });
            }
            const wallet = importWalletFromPrivateKey(privateKey);
            res.json({
                success: true,
                wallet: wallet
            });
        } catch (err) {
            res.status(400).json({
                success: false,
                error: '私钥导入失败: ' + err.message
            });
        }
    });

    // 2. 提交一笔转账到交易池（需要 ECDSA 签名）
    router.post('/api/transaction', (req, res) => {
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
            broadcastToFrontend('newTransaction', {
                poolCount: starCoin.pendingTransactions.length,
                txId: savedTx.id
            });
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
    router.get('/api/balance/:address', (req, res) => {
        const address = req.params.address;
        const balance = starCoin.getBalance(address);
        const totalBalance = starCoin.getBalance(address, true);
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
    router.get('/api/transactions/:address', (req, res) => {
        const history = starCoin.getTransactionHistory(req.params.address);
        res.json({
            success: true,
            address: req.params.address,
            total: history.length,
            transactions: history
        });
    });

    // 5. 查看交易池 (Mempool)
    router.get('/api/mempool', (req, res) => {
        res.json({
            success: true,
            count: starCoin.pendingTransactions.length,
            transactions: starCoin.pendingTransactions
        });
    });

    // 6. 清空交易池
    router.delete('/api/mempool', (req, res) => {
        const count = starCoin.pendingTransactions.length;
        starCoin.pendingTransactions = [];
        res.json({
            success: true,
            message: `已清空 ${count} 笔待打包交易`,
            cleared: count
        });
    });

    // 7. 所有地址排行榜
    router.get('/api/addresses', (req, res) => {
        const addresses = starCoin.getAllAddresses();
        res.json({
            success: true,
            total: addresses.length,
            addresses: addresses
        });
    });

    // 8. 挖矿（从交易池打包交易）
    router.post('/api/mine', (req, res) => {
        const { minerAddress, data } = req.body;
        const startTime = Date.now();
        try {
            const newBlock = starCoin.mineBlock(minerAddress || starCoin.miningAddress, data);
            const miningTime = Date.now() - startTime;

            p2p.broadcastLatest();
            p2p.updateNodeInfo();

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
    // 支持自动持续挖矿：当挖矿过程中链被外部更新时，自动切换到新链重新挖矿
    router.get('/api/mine/stream', async (req, res) => {
        const minerAddress = req.query.minerAddress || starCoin.miningAddress;

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        // 持续挖矿标志：当中止时自动重启
        let keepMining = true;
        let consecutiveCancels = 0;

        while (keepMining) {
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
                });

                // 如果挖矿被取消（链已更新），自动在新链上重新开始挖矿
                if (result && result.canceled) {
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

                p2p.broadcastLatest();
                p2p.updateNodeInfo();

                broadcastToFrontend('newBlock', {
                    blockIndex: result.index,
                    blockHash: result.hash,
                    transactionCount: result.transactions.length,
                    difficulty: starCoin.difficulty,
                    source: 'sse-mining'
                });

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
                res.write(`data: ${JSON.stringify({
                    found: false,
                    error: err.message,
                    message: '❌ ' + err.message
                })}\n\n`);
                keepMining = false;
            }
        }

        res.end();
    });

    // 9. 验证区块链
    router.get('/api/validate', (req, res) => {
        res.json({
            success: true,
            isValid: starCoin.isChainValid(),
            totalBlocks: starCoin.chain.length
        });
    });

    // ============================================================
    // 节点同步 API
    // ============================================================

    router.post('/api/sync', (req, res) => {
        const result = p2p.syncWithPeers();
        res.json({
            ...result,
            valid: starCoin.isChainValid(),
            syncState: p2p.getSyncState()
        });
    });

    router.get('/api/sync/status', (req, res) => {
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
    // 数据持久化 API
    // ============================================================

    router.get('/api/storage/status', (req, res) => {
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

    router.post('/api/storage/save', (req, res) => {
        const success = starCoin.saveToFile();
        res.json({
            success: success,
            message: success ? '✅ 区块链已保存到本地文件' : '❌ 保存失败',
            totalBlocks: starCoin.chain.length,
            file: starCoin.dataFile
        });
    });

    router.post('/api/storage/reload', (req, res) => {
        const success = starCoin.loadFromFile();
        res.json({
            success: success,
            message: success ? '✅ 已从本地文件重新加载区块链' : '⚠️  无法从文件加载（已重建创世区块）',
            totalBlocks: starCoin.chain.length
        });
    });

    router.post('/api/storage/reset', (req, res) => {
        const success = starCoin.clearDataFile();
        p2p.broadcastLatest();
        res.json({
            success: success,
            message: success ? '🔄 已重置区块链为创世区块状态' : '❌ 重置失败',
            totalBlocks: starCoin.chain.length
        });
    });

    router.get('/api/storage/export', (req, res) => {
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

    router.post('/api/storage/import', (req, res) => {
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
    // 节点连接 API
    // ============================================================

    router.post('/api/connect', (req, res) => {
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

    router.post('/api/disconnect', (req, res) => {
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

    router.get('/api/nodes', (req, res) => {
        res.json({
            nodes: p2p.getNodeUrls(),
            count: p2p.getConnectedCount(),
            currentNode: p2p.nodeInfo
        });
    });

    router.get('/api/all-nodes', async (req, res) => {
        const allNodes = await p2p.getAllNodeInfo();
        res.json({
            nodes: allNodes,
            total: allNodes.length
        });
    });

    // ============================================================
    // 自动节点发现 API
    // ============================================================

    router.get('/api/discovery/status', (req, res) => {
        res.json({
            success: true,
            discovery: p2p.getDiscoveryStatus()
        });
    });

    router.post('/api/discovery/start', (req, res) => {
        p2p.startDiscovery();
        res.json({
            success: true,
            message: '✅ 自动节点发现已启动',
            status: p2p.getDiscoveryStatus()
        });
    });

    router.post('/api/discovery/stop', (req, res) => {
        p2p.stopDiscovery();
        res.json({
            success: true,
            message: '⏸️ 自动节点发现已停止',
            status: p2p.getDiscoveryStatus()
        });
    });

    router.post('/api/discovery/scan', (req, res) => {
        p2p.requestNodeLists();
        res.json({
            success: true,
            message: '🔍 已发起节点发现扫描',
            status: p2p.getDiscoveryStatus()
        });
    });

    return router;
}

module.exports = createRoutes;