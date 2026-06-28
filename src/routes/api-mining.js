// ============================================================
// routes/api-mining.js — 挖矿相关路由
// ============================================================
const express = require('express');
const { Block } = require('../blockchain/blockchain');
const { AppError, wrapAsync } = require('./error-handler');
const logger = require('../logger');

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
    router.post('/mine', wrapAsync(async (req, res) => {
        const { minerAddress, data } = req.body;
        if (!minerAddress && !starCoin.miningAddress) {
            throw new AppError(400, '必须提供 minerAddress 参数，或先配置 miningAddress', 'MISSING_MINER');
        }
        const startTime = Date.now();
        let newBlock;
        try {
            newBlock = starCoin.mineBlock(minerAddress || starCoin.miningAddress, data);
        } catch (err) {
            throw new AppError(400, err.message || '挖矿失败', 'MINE_FAILED');
        }
        if (!newBlock || !newBlock.hash) {
            throw new AppError(500, '挖矿失败，未返回有效区块', 'MINE_FAILED');
        }
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
    }));

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
                    // 指数退避：连续取消越频繁，等待越久，让多个节点自然错峰
                    const backoffDelay = Math.min(200 * Math.pow(1.5, consecutiveCancels - 1), 3000);
                    if (consecutiveCancels > 15) {
                        // 连续取消超过 15 次，暂停 10 秒让链稳定下来
                        logger.module('Mining').warn('链频繁更新，暂停 10s 让链稳定', { consecutiveCancels });
                        res.write(`data: ${JSON.stringify({
                            found: false,
                            error: '链频繁更新，暂停 10s',
                            message: '⏸️ 链频繁更新，暂停 10 秒让链稳定...'
                        })}\n\n`);
                        await new Promise(r => setTimeout(r, 10000));
                        consecutiveCancels = Math.max(0, consecutiveCancels - 5); // 恢复部分计数
                        // 继续循环尝试，不退出
                        continue;
                    }
                    logger.module('Mining').info('链已更新，自动在新链上重新开始挖矿', { consecutiveCancels, newChainLength: starCoin.chain.length, backoffDelay });
                    res.write(`data: ${JSON.stringify({
                        chainUpdated: true,
                        newChainLength: starCoin.chain.length,
                        difficulty: starCoin.difficulty,
                        backoffDelay,
                        message: '🔄 区块链已更新（高度=' + starCoin.chain.length + '），' + (backoffDelay > 0 ? Math.round(backoffDelay) + 'ms 后重新开始...' : '立即重新开始...')
                    })}\n\n`);
                    // 退避等待，让其他节点先稳定
                    if (backoffDelay > 0) {
                        await new Promise(r => setTimeout(r, backoffDelay));
                    }
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