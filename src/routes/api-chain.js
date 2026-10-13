// ============================================================
// routes/api-chain.js — 区块链信息与验证路由
// ============================================================
const express = require('express');
const { targetForDifficulty, targetHex } = require('../protocol');
const { wrapAsync } = require('./error-handler');

/**
 * 创建区块链信息相关的路由
 * @param {object} starCoin  - Blockchain 实例
 * @param {object} p2p       - P2P 网络层实例
 * @param {string|number} PORT - 当前服务器端口号
 * @returns {express.Router}
 */
function createChainRoutes(starCoin, p2p, PORT) {
    const router = express.Router();

    // ============================================================
    // 区块链概览信息
    // ============================================================
    router.get('/blockchain', wrapAsync(async (req, res) => {
        res.json({
            chain: starCoin.chain,
            isValid: await starCoin.isChainValid(),
            stats: {
                totalBlocks: starCoin.chain.length,
                chainWork: (await starCoin.getChainWork()).toString(),
                chainId: starCoin.consensus.params.chainId,
                protocolVersion: starCoin.evmEnabled ? 3 : 2,
                activationHeight: starCoin.consensus.params.activationHeight,
                paymentConfirmations: starCoin.paymentConfirmations,
                reorgEvents: starCoin.reorgEvents,
                difficulty: starCoin.difficulty,
                target: targetHex(targetForDifficulty(starCoin.difficulty)),
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
    }));

    // ============================================================
    // 验证区块链完整性
    // ============================================================
    router.get('/validate', wrapAsync(async (req, res) => {
        res.json({
            success: true,
            isValid: await starCoin.isChainValid(),
            totalBlocks: starCoin.chain.length
        });
    }));

    return router;
}

module.exports = createChainRoutes;
