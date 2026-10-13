/* Browser signing compatible with StarCoin's existing SPKI, BIP32 and ECDSA formats. */
const walletCrypto = (() => {
    const lib = typeof ethers !== 'undefined' ? ethers : require('ethers');
    const BASE_PATH = "m/44'/1'/0'/0", MAX_INDEX = 0x7fffffff;
    const algorithm = '301006072a8648ce3d020106052b8104000a';
    function der(tag, value) {
        const length = value.length / 2;
        const size = length < 128 ? length.toString(16).padStart(2, '0')
            : length < 256 ? '81' + length.toString(16).padStart(2, '0') : '82' + length.toString(16).padStart(4, '0');
        return tag + size + value;
    }
    function toPem(privateKey) {
        const sec1 = der('30', '020101' + der('04', privateKey.slice(2)));
        const bytes = lib.getBytes('0x' + der('30', '020100' + algorithm + der('04', sec1)));
        const encoded = typeof btoa === 'function' ? btoa(String.fromCharCode(...bytes)) : Buffer.from(bytes).toString('base64');
        return '-----BEGIN PRIVATE KEY-----\n' + encoded.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
    }
    function rawFromPem(pem) {
        if (typeof pem !== 'string' || pem.length > 4096) throw new Error('无效的 PEM 私钥');
        const match = /^\s*-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----\s*$/.exec(pem);
        if (!match) throw new Error('需要 PKCS#8 PEM 私钥');
        const bytes = typeof atob === 'function' ? Uint8Array.from(atob(match[1].replace(/\s/g, '')), c => c.charCodeAt(0))
            : Uint8Array.from(Buffer.from(match[1].replace(/\s/g, ''), 'base64'));
        function read(offset, limit = bytes.length) {
            const start = offset, tag = bytes[offset++]; let length = bytes[offset++];
            if (length & 128) {
                const size = length & 127;
                if (!size || size > 2 || offset + size > limit) throw new Error('无效 ASN.1 长度');
                length = 0; for (let i = 0; i < size; i++) length = length * 256 + bytes[offset++];
            }
            const end = offset + length;
            if (end > limit || end < offset) throw new Error('无效 ASN.1 私钥');
            return { tag, start, offset, end, hex: lib.hexlify(bytes.slice(offset, end)).slice(2) };
        }
        const root = read(0); if (root.tag !== 48 || root.end !== bytes.length) throw new Error('无效 PKCS#8');
        const version = read(root.offset, root.end), alg = read(version.end, root.end), secret = read(alg.end, root.end);
        if (version.tag !== 2 || version.hex !== '00' || alg.tag !== 48
            || lib.hexlify(bytes.slice(alg.start, alg.end)).slice(2) !== algorithm
            || secret.tag !== 4 || secret.end !== root.end) throw new Error('仅支持 secp256k1 PKCS#8 私钥');
        const inner = read(secret.offset, secret.end);
        if (inner.tag !== 48 || inner.end !== secret.end) throw new Error('无效 EC 私钥');
        const ecVersion = read(inner.offset, inner.end), scalar = read(ecVersion.end, inner.end);
        if (ecVersion.tag !== 2 || ecVersion.hex !== '01' || scalar.tag !== 4 || scalar.hex.length !== 64) throw new Error('无效 EC 私钥');
        // Any embedded curve/public key must agree with the private scalar.
        const key = new lib.SigningKey('0x' + scalar.hex);
        let offset = scalar.end;
        while (offset < inner.end) {
            const field = read(offset, inner.end);
            if (field.tag === 160 && field.hex !== '06052b8104000a') throw new Error('EC 曲线不匹配');
            if (field.tag === 161) {
                const point = read(field.offset, field.end);
                if (point.tag !== 3 || point.end !== field.end || point.hex !== '00' + key.publicKey.slice(2)) throw new Error('EC 公钥不匹配');
            }
            if (![160, 161].includes(field.tag)) throw new Error('无效 EC 私钥字段');
            offset = field.end;
        }
        return key.privateKey;
    }
    function walletFromRaw(raw) {
        const key = new lib.SigningKey(raw), publicKey = '3056301006072a8648ce3d020106052b8104000a034200' + key.publicKey.slice(2);
        return { privateKey: toPem(key.privateKey), publicKey, address: lib.sha256('0x' + publicKey).slice(2, 34) };
    }
    function importPem(pem) { return { ...walletFromRaw(rawFromPem(pem)), privateKey: pem.trim() + '\n' }; }
    function mnemonic(value, passphrase = '') {
        if (typeof value !== 'string' || value.length > 1024 || typeof passphrase !== 'string' || passphrase.length > 1024) throw new Error('助记词或 BIP39 密码无效');
        return lib.Mnemonic.fromPhrase(value.trim().replace(/\s+/g, ' ').toLowerCase(), passphrase);
    }
    function legacyWallet(phrase, passphrase = '') {
        const words = mnemonic(phrase, passphrase);
        return { ...walletFromRaw(words.computeSeed().slice(0, 66)), mnemonic: words.phrase };
    }
    function newMnemonic(strength = 128) {
        if (![128, 256].includes(strength)) throw new Error('strength 仅支持 128 或 256');
        return lib.Mnemonic.fromEntropy(lib.randomBytes(strength / 8)).phrase;
    }
    function hdContext(body) {
        if ((body.scheme !== undefined && body.scheme !== 'bip44-v1') || (body.basePath !== undefined && body.basePath !== BASE_PATH)) throw new Error('不支持的 HD 派生方案或路径');
        const words = mnemonic(body.mnemonic, body.passphrase), branch = lib.HDNodeWallet.fromSeed(words.computeSeed()).derivePath(BASE_PATH);
        return { branch, mnemonic: words.phrase, root: { id: lib.sha256(lib.toUtf8Bytes(branch.neuter().extendedKey)).slice(2),
            type: 'hd', scheme: 'bip44-v1', basePath: BASE_PATH } };
    }
    function index(value) { if (!Number.isSafeInteger(value) || value < 0 || value > MAX_INDEX) throw new Error('HD 地址索引越界'); return value; }
    function derive(context, value) {
        const child = context.branch.deriveChild(index(value));
        return { ...walletFromRaw(child.privateKey), type: 'hd', rootId: context.root.id, index: child.index, path: BASE_PATH + '/' + child.index };
    }
    function hdDerive(body) {
        const context = hdContext(body), start = index(body.startIndex ?? 0), count = body.count ?? 1;
        if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error('HD 批次数量无效');
        const indices = body.indices ?? Array.from({ length: count }, (_, i) => start + i);
        if (!Array.isArray(indices) || !indices.length || indices.length > 100) throw new Error('HD 索引数量无效');
        const wallets = [...new Set(indices)].map(i => derive(context, i));
        return { root: context.root, wallets, nextIndex: Math.max(...wallets.map(w => w.index)) + 1 };
    }
    function hdDiscover(body, isUsed) {
        const context = hdContext(body), start = index(body.startIndex ?? 0), scanCount = body.scanCount ?? 200;
        if (!Number.isSafeInteger(scanCount) || scanCount < 20 || scanCount > 200) throw new Error('HD 扫描数量无效');
        let gap = 0, nextIndex = start === 0 ? 1 : 0, scanNextIndex = start; const wallets = [];
        for (let scanned = 0; scanned < scanCount && scanNextIndex <= MAX_INDEX; scanned++) {
            const wallet = derive(context, scanNextIndex); scanNextIndex = wallet.index + 1;
            if (isUsed(wallet.address)) { wallets.push(wallet); nextIndex = scanNextIndex; gap = 0; }
            else { gap++; if (start === 0 && wallet.index === 0) wallets.push(wallet); }
            if (gap >= 20) break;
        }
        return { root: context.root, wallets, nextIndex, scanNextIndex, gapLimit: 20, stoppedAtGap: gap >= 20, exhausted: scanNextIndex > MAX_INDEX };
    }
    function units(value) {
        const text = String(value);
        if (!/^\d{1,20}(?:\.\d{1,8})?$/.test(text)) throw new Error('金额必须非负且最多八位小数');
        const result = lib.parseUnits(text, 8);
        if (result > (1n << 63n) - 1n) throw new Error('金额超出范围'); return result;
    }
    function signature(id, pem) {
        // Existing Node signatures hash the UTF-8 hexadecimal string, not its decoded bytes.
        const signed = new lib.SigningKey(rawFromPem(pem)).sign(lib.sha256(lib.toUtf8Bytes(id)));
        const integer = hex => { let value = hex.slice(2).replace(/^(00)+/, ''); if (parseInt(value.slice(0, 2), 16) >= 128) value = '00' + value; return der('02', value); };
        return der('30', integer(signed.r) + integer(signed.s));
    }
    function signNative(pem, options) {
        const wallet = importPem(pem);
        if (!/^[0-9a-f]{32}$/.test(options.to) || units(options.amount) <= 0n) throw new Error('接收地址或金额无效');
        const tx = { version: 2, chainId: options.chainId, from: wallet.address, to: options.to, amount: options.amount,
            fee: options.fee ?? '0', note: options.note ?? '', currency: options.currency ?? 'STC', nonce: options.nonce,
            timestamp: options.timestamp || new Date().toISOString(), publicKey: wallet.publicKey };
        tx.id = lib.sha256(lib.toUtf8Bytes(JSON.stringify(['StarCoin/transaction', 2, tx.chainId, tx.from, tx.to,
            units(tx.amount).toString(), units(tx.fee).toString(), tx.currency, tx.nonce ?? null, tx.note, tx.timestamp, null]))).slice(2);
        tx.signature = signature(tx.id, pem); return tx;
    }
    function signEnvelope(pem, options) {
        const wallet = importPem(pem), tx = { version: 3, chainId: options.chainId, kind: options.kind,
            from: wallet.address, to: options.to, amount: options.amount ?? '0', fee: '0', note: '', currency: 'STC',
            nonce: options.nonce, timestamp: options.timestamp || new Date().toISOString(), evmAddress: options.evmAddress,
            rawTransaction: options.rawTransaction || '', publicKey: wallet.publicKey };
        tx.id = lib.sha256(lib.toUtf8Bytes(JSON.stringify(['StarCoin/evm-envelope', 3, tx.chainId, tx.kind, tx.from, tx.to,
            units(tx.amount).toString(), '0', tx.nonce, tx.timestamp, tx.evmAddress, tx.rawTransaction]))).slice(2);
        tx.signature = signature(tx.id, pem); return tx;
    }
    return { importPem, rawFromPem, walletFromRaw, legacyWallet, newMnemonic, hdDerive, hdDiscover, units, signNative, signEnvelope };
})();

async function localHdWallet(operation, body = {}) {
    if (operation === 'new') {
        const phrase = walletCrypto.newMnemonic(body.strength ?? 128);
        return { mnemonic: phrase, ...walletCrypto.hdDerive({ ...body, mnemonic: phrase }) };
    }
    if (operation === 'derive') return walletCrypto.hdDerive(body);
    if (operation !== 'import') throw new Error('未知 HD 操作');
    const [history, pending] = await Promise.all([api('/api/addresses'), api('/api/mempool')]);
    const used = new Set((history.addresses || []).map(item => item.address));
    for (const tx of pending.transactions || []) { used.add(tx.from); used.add(tx.to); }
    return walletCrypto.hdDiscover(body, address => used.has(address));
}
if (typeof module !== 'undefined' && module.exports) module.exports = walletCrypto;
