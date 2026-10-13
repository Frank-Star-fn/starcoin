const sensitive = /^(?:privatekey(?:pem)?|mnemonic|passphrase|password|seed|xprv|authorization|cookie|admin[_-]?token)$/i;
function redact(value, seen = new WeakSet(), depth = 0) {
    if (typeof value === 'string') return value
        .replace(/-----BEGIN (?:EC )?PRIVATE KEY-----[\s\S]*?-----END (?:EC )?PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
        .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
        .replace(/([?&](?:privateKey(?:Pem)?|mnemonic|passphrase|password|token|adminToken)=)[^&\s]*/gi, '$1[REDACTED]');
    if (!value || typeof value !== 'object') return value;
    if (depth > 10 || seen.has(value)) return '[REDACTED NESTED DATA]';
    seen.add(value);
    if (Array.isArray(value)) return value.map(item => redact(item, seen, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.test(key) ? '[REDACTED]' : redact(item, seen, depth + 1)]));
}
module.exports = redact;
