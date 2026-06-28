/**
 * 搜索 API
 * 统一搜索入口：按区块号 / 交易ID / 地址 / 备注 搜索
 */
const express = require('express');
const logger = require('../logger');
const router = express.Router();

module.exports = function (blockchain) {

    /**
     * GET /api/search?q=<query>
     *
     * 统一搜索接口，自动识别查询类型：
     *   - 纯数字 → 区块号
     *   - 32位 hex → 地址
     *   - 64位 hex → 交易ID / 区块hash
     *   - 其他 → 备注模糊搜索 + 交易池搜索
     */
    router.get('/search', (req, res) => {
        try {
            const query = (req.query.q || '').trim();
            if (!query) {
                return res.json({
                    success: true,
                    type: 'empty',
                    query: '',
                    result: null
                });
            }

            const result = blockchain.search(query);
            return res.json({
                success: true,
                ...result
            });
        } catch (err) {
            logger.module('API').error('搜索出错', { error: err.message });
            return res.status(500).json({
                success: false,
                type: 'error',
                query: req.query.q || '',
                error: err.message
            });
        }
    });

    return router;
};