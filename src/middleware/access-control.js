const { timingSafeEqual } = require('crypto');
const config = require('../config');

function reject(res, status, code, error) {
    return res.status(status).json({ success: false, statusCode: status, code, error });
}

function allowedHost(req) {
    try {
        const host = req.headers.host;
        if (!host || /[\s/@\\]/.test(host)) return false;
        return config.HTTP_ALLOWED_HOSTS.includes(new URL('http://' + host).hostname.toLowerCase());
    } catch { return false; }
}

// Host validation also prevents a browser on an unrelated domain from rebinding to the node.
function sameOrigin(req, trustProxy = req.app?.get('trust proxy fn')) {
    if (!allowedHost(req)) return false;
    const origin = req.headers.origin;
    if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';
    let protocol = req.protocol || (req.socket?.encrypted ? 'https' : 'http');
    if (!req.protocol && trustProxy?.(req.socket?.remoteAddress, 0)) {
        const forwarded = req.headers['x-forwarded-proto']?.split(',')[0].trim();
        if (['http', 'https'].includes(forwarded)) protocol = forwarded;
    }
    try { return new URL(origin).origin === `${protocol}://${req.headers.host}`; }
    catch { return false; }
}

function requireAdmin(req, res, next) {
    if (!config.ADMIN_TOKEN) return reject(res, 503, 'ADMIN_DISABLED', '管理操作未启用，请配置 ADMIN_TOKEN');
    if (!sameOrigin(req)) return reject(res, 403, 'ORIGIN_FORBIDDEN', '管理请求来源不受信任');
    const header = req.headers.authorization || '';
    const supplied = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const expected = Buffer.from(config.ADMIN_TOKEN);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        return reject(res, 401, 'UNAUTHORIZED', '需要有效的管理凭证');
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
}

function protectHttp(req, res, next) {
    if (!allowedHost(req)) return reject(res, 403, 'HOST_FORBIDDEN', '请求主机不受信任');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
}

module.exports = { requireAdmin, protectHttp, allowedHost, sameOrigin };
module.exports.requireLegacyWallet = function requireLegacyWallet(req, res, next) {
    res.setHeader('Cache-Control', 'no-store');
    if (!config.LEGACY_WALLET_API) return reject(res, 410, 'LEGACY_WALLET_DISABLED', '旧钱包接口已禁用，请在浏览器签名后提交交易');
    // The actual transport peer, never a proxy header, decides local compatibility access.
    const remote = req.socket?.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)
        || ['forwarded', 'x-forwarded-for', 'x-real-ip'].some(header => req.headers[header])) return reject(res, 403, 'LOCAL_ONLY', '旧钱包接口仅允许本机直连');
    return requireAdmin(req, res, next);
};
