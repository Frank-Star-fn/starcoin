// ============================================================
// routes/api-mining.js — 挖矿相关路由
// ============================================================
const express = require('express');
const { Block } = require('../blockchain');

/**
 * 创建挖矿相关的路由
 * @param {object} starCoin               - Blockchain 实例
 * @param {object} p2p                    - P2P 网络层实例
 * @param {function} broadcastToFrontend  - WebSocket 广播函数
 * @returns {express.Router}
 */
function createMiningRoutes(starCoin, p2p, broadcastToFrontend) {
    const router = express.Router();

    // ============================================================
    // 8. 挖矿（从交易池打包交易）
    // ============================================================
    router.post('/mine', (req, res) => {
        const { minerAddress, data } = req.body;
        const startTime = Date.now();
        try {
            const newBlock = starCoin.mineBlock(minerAddress || starCoin.miningAddress, data);
            const miningTime = Date.now() - startTime;

            // 广播新区块到其他节点
            p2p.broadcastLatest();
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

    // ============================================================
    // 8b. SSE 挖矿进度流（带可视化动画）
    // ============================================================
    router.get('/mine/stream', async (req, res) => {
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
                const result = await starCoin.mineBlockAsync(minerAddress, null, (progress) => {
                    if (progress.aborted) {
                        res.write(`data: ${JSON.stringify({
                            ...progress,
                            message: '🔄 检测到区块链更新，正在切换到新链...'
                        })}\n\n`);
                    } else {
                        res.write(`data: ${JSON.stringify(progress)}\n\n`);
                    }
                }, () => clientDisconnected);

                if (result && result.canceled) {
                    if (clientDisconnected) {
                        keepMining = false;
                        break;
                    }
                    consecutiveCancels++;
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
                    res.write(`data: ${JSON.stringify({
                        chainUpdated: true,
                        newChainLength: starCoin.chain.length,
                        difficulty: starCoin.difficulty,
                        message: '🔄 区块链已更新（高度=' + starCoin.chain.length + '），自动切换到新链继续挖矿...'
                    })}\n\n`);
                    continue;
                }

                consecutiveCancels = 0;

                p2p.broadcastLatest();
                p2p.broadcastPendingTxs();
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

                keepMining = false;
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

    return router;
}

module.exports = createMiningRoutes;