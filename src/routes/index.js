// ============================================================
// routes/index.js — StarCoin 路由入口
// 组合所有 API 路由，统一挂载到 /api 路径下
// 并按接口权重挂载分级限流中间件
// ============================================================
const express = require('express');
const config = require('../config');
const createRateLimiter = require('../middleware/rate-limit');
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

    // ============================================================
    // 分级限流中间件（每个实例拥有独立的 IP 计数器）
    //   globalLimiter  - 全局限流：所有 /api/* 接口
    //   writeLimiter   - 写操作限流：钱包 / 交易 / 挖矿 / 存储 / 节点操作
    //   searchLimiter  - 搜索限流：较重的查询接口
    // ============================================================
    const globalLimiter = createRateLimiter({
        windowMs: config.RATE_LIMIT_GLOBAL_WINDOW_MS,
        max: config.RATE_LIMIT_GLOBAL_MAX
    });

    const writeLimiter = createRateLimiter({
        windowMs: config.RATE_LIMIT_WRITE_WINDOW_MS,
        max: config.RATE_LIMIT_WRITE_MAX,
        message: '写操作过于频繁，请稍后再试'
    });

    const searchLimiter = createRateLimiter({
        windowMs: config.RATE_LIMIT_SEARCH_WINDOW_MS,
        max: config.RATE_LIMIT_SEARCH_MAX,
        message: '搜索请求过于频繁，请稍后再试'
    });

    // 1. 全局限流（第一道关卡：对所有 /api/* 接口生效）
    router.use(globalLimiter);

    // 2. 写操作限流（对以下子路由额外使用更严格的限制）
    router.use('/wallet', writeLimiter);
    router.use('/transaction', writeLimiter);
    router.use('/mine', writeLimiter);
    router.use('/mempool', writeLimiter);
    router.use('/storage', writeLimiter);
    router.use('/sync', writeLimiter);
    router.use('/connect', writeLimiter);
    router.use('/disconnect', writeLimiter);
    router.use('/discovery', writeLimiter);

    // 3. 搜索限流（中等限制）
    router.use('/search', searchLimiter);

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