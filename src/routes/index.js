// ============================================================
// routes/index.js — StarCoin 路由入口
// 组合所有业务子路由，统一挂载到 /api 路径下
// ============================================================
const express = require('express');
const createChainRoutes = require('./api-chain');
const createTxRoutes = require('./api-tx');
const createMiningRoutes = require('./api-mining');
const createNetRoutes = require('./api-net');
const createSearchRoutes = require('./api-search');
const {
    createNotFoundMiddleware,
    createErrorMiddleware
} = require('./error-handler');

/**
 * 创建并返回一个 Express Router，挂载所有 API 路由
 * @param {object} starCoin               - Blockchain 实例
 * @param {object} p2p                    - P2P 网络层实例
 * @param {function} broadcastToFrontend  - WebSocket 广播函数
 * @param {string|number} PORT            - 当前服务器端口号
 * @returns {express.Router}
 */
function createRoutes(starCoin, p2p, broadcastToFrontend, PORT) {
    const router = express.Router();

    // 按业务领域挂载子路由
    router.use(createChainRoutes(starCoin, p2p, PORT));
    router.use(createTxRoutes(starCoin, broadcastToFrontend, p2p));
    router.use(createMiningRoutes(starCoin, p2p, broadcastToFrontend));
    router.use(createNetRoutes(starCoin, p2p, PORT));
    router.use(createSearchRoutes(starCoin));

    // ========== 全局错误处理（仅针对 /api 路径下的路由） ==========
    // 404 兜底：API 路径不存在时返回统一 JSON 格式
    router.use(createNotFoundMiddleware());
    // 统一错误响应
    router.use(createErrorMiddleware());

    return router;
}

module.exports = createRoutes;