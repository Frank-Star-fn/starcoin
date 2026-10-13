const { isIP } = require('net');
// req.ip is resolved by Express using the explicitly configured trusted proxies.
function clientIp(req) {
    let ip = req.ip;
    if (!isIP(ip || '')) ip = req.socket?.remoteAddress;
    if (!isIP(ip || '')) return 'unknown';
    if (isIP(ip) === 6) {
        ip = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
        const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
        if (mapped) {
            const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
            return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
        }
    }
    return ip;
}
module.exports = clientIp;
