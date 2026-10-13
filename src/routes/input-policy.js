const { AppError } = require('./error-handler');
function nativeAddress(value) { return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value); }
function requireNativeAddress(value) {
    if (!nativeAddress(value)) throw new AppError(400, '原生地址必须是 32 位小写十六进制字符串', 'INVALID_ADDRESS');
    return value;
}
module.exports = { nativeAddress, requireNativeAddress };
