/**
 * 从请求中获取客户端 IP
 * 优先级：X-Forwarded-For 头（第一个 IP）→ X-Real-IP → req.ip
 */
function _getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff && typeof xff === 'string') {
        const first = xff.split(',')[0].trim();
        if (first) return first;
    }
    const xRealIp = req.headers['x-real-ip'];
    if (xRealIp && typeof xRealIp === 'string') {
        return xRealIp.trim();
    }
    return (req.ip && req.ip !== '::ffff:127.0.0.1') ? req.ip : '127.0.0.1';
}

/**
 * 创建一个基于滑动窗口的 IP 限流中间件
 *
 * @param {object} options
 * @param {number} options.windowMs        - 时间窗口（毫秒），默认 60000
 * @param {number} options.max             - 窗口内允许的最大请求数，默认 60
 * @param {string} [options.message]       - 超限错误消息
 * @param {number} [options.cleanupIntervalMs] - 内部清理过期记录的间隔（毫秒），默认 windowMs * 2
 * @returns {function} Express 中间件
 */
function createRateLimiter(options = {}) {
    const windowMs = options.windowMs || 60 * 1000;
    const max = options.max || 60;
    const message = options.message || '请求过于频繁，请稍后再试';
    const cleanupIntervalMs = options.cleanupIntervalMs || windowMs * 2;

    // key: ip, value: [{ timestamp: ms }, ...]
    const requests = new Map();

    // 定时清理过期记录，防止内存无限增长
    const cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [ip, timestamps] of requests.entries()) {
            const filtered = timestamps.filter(ts => now - ts < windowMs);
            if (filtered.length === 0) {
                requests.delete(ip);
            } else if (filtered.length !== timestamps.length) {
                requests.set(ip, filtered);
            }
        }
    }, cleanupIntervalMs);

    // 避免 Node 未处理定时器阻止进程退出（仅在有 event 时触发）
    if (cleanupTimer.unref) cleanupTimer.unref();

    /**
     * Express 中间件
     */
    return function rateLimiter(req, res, next) {
        const ip = _getClientIp(req);
        const now = Date.now();

        let timestamps = requests.get(ip);
        if (!timestamps) {
            timestamps = [];
            requests.set(ip, timestamps);
        }

        // 剔除窗口外的记录
        while (timestamps.length > 0 && now - timestamps[0] >= windowMs) {
            timestamps.shift();
        }

        // 超限检查（当前请求尚未计入）
        if (timestamps.length >= max) {
            const resetTimestamp = new Date(timestamps[0] + windowMs);
            const resetAfterMs = Math.max(0, resetTimestamp.getTime() - now);

            res.setHeader('X-RateLimit-Limit', String(max));
            res.setHeader('X-RateLimit-Remaining', '0');
            res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetTimestamp.getTime() / 1000)));
            res.setHeader('Retry-After', String(Math.ceil(resetAfterMs / 1000)));
            res.status(429).json({
                success: false,
                error: message,
                code: 'TOO_MANY_REQUESTS',
                statusCode: 429,
                details: {
                    limit: max,
                    remaining: 0,
                    resetAfterMs: resetAfterMs
                }
            });
            return;
        }

        // 记录当前请求（计入计数后再计算 remaining）
        timestamps.push(now);
        const remaining = max - timestamps.length;
        const resetTimestamp = new Date(timestamps[0] + windowMs);
        const resetAfterMs = Math.max(0, resetTimestamp.getTime() - now);

        // 设置标准限流响应头
        res.setHeader('X-RateLimit-Limit', String(max));
        res.setHeader('X-RateLimit-Remaining', String(remaining));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetTimestamp.getTime() / 1000)));

        next();
    };
}

module.exports = createRateLimiter;