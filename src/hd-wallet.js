const crypto = require('crypto');
const bip39 = require('bip39');
const { BIP32Factory } = require('bip32');
const ecc = require('tiny-secp256k1');
const { rawPrivateKeyToPEM, getPublicKeyFromPrivateKeyPem, publicKeyToAddress } = require('./core');

const bip32 = BIP32Factory(ecc);
const HD_SCHEME = 'bip44-v1';
// Demo test network namespace. Addresses still use StarCoin's SPKI/SHA256 format.
const HD_BASE_PATH = "m/44'/1'/0'/0";
const MAX_INDEX = 0x7fffffff;
const MAX_BATCH = 100;
const GAP_LIMIT = 20;

function integer(value, name, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
    }
    return value;
}

function validateScheme(scheme = HD_SCHEME, basePath = HD_BASE_PATH) {
    if (scheme !== HD_SCHEME || basePath !== HD_BASE_PATH) throw new Error('不支持的 HD 派生方案或路径');
}

function createHdContext(mnemonic, passphrase = '', scheme, basePath) {
    validateScheme(scheme, basePath);
    if (typeof mnemonic !== 'string' || mnemonic.length > 1024) throw new Error('无效的助记词');
    if (typeof passphrase !== 'string' || passphrase.length > 1024) throw new Error('无效的 BIP39 密码');
    const normalized = mnemonic.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!bip39.validateMnemonic(normalized)) throw new Error('助记词无效：请检查单词和校验和');
    const seed = bip39.mnemonicToSeedSync(normalized, passphrase);
    const branch = bip32.fromSeed(seed).derivePath(HD_BASE_PATH);
    seed.fill(0);
    const id = crypto.createHash('sha256').update(branch.neutered().toBase58()).digest('hex');
    return { branch, mnemonic: normalized, root: { id, type: 'hd', scheme: HD_SCHEME, basePath: HD_BASE_PATH } };
}

function deriveAddress(context, index) {
    integer(index, 'index', 0, MAX_INDEX);
    const child = context.branch.derive(index);
    // BIP32 may skip an invalid child. Use its actual index in all metadata.
    if (child.index > MAX_INDEX) throw new Error('HD 地址索引已耗尽');
    const privateKey = rawPrivateKeyToPEM(Buffer.from(child.privateKey));
    const publicKey = getPublicKeyFromPrivateKeyPem(privateKey);
    return { type: 'hd', rootId: context.root.id, index: child.index,
        path: `${HD_BASE_PATH}/${child.index}`, privateKey, publicKey, address: publicKeyToAddress(publicKey) };
}

function deriveAddresses(context, startIndex = 0, count = 1) {
    integer(startIndex, 'startIndex', 0, MAX_INDEX);
    integer(count, 'count', 1, MAX_BATCH);
    if (startIndex + count - 1 > MAX_INDEX) throw new Error('HD 地址索引越界');
    const wallets = [];
    let nextIndex = startIndex;
    for (let i = 0; i < count; i++) {
        const wallet = deriveAddress(context, nextIndex);
        wallets.push(wallet);
        nextIndex = wallet.index + 1;
    }
    return { root: context.root, wallets, nextIndex };
}

// A bounded scan can be resumed even after a gap, for addresses issued far ahead.
function discoverAddresses(context, isUsed, options = {}) {
    const startIndex = integer(options.startIndex ?? 0, 'startIndex', 0, MAX_INDEX);
    const scanCount = integer(options.scanCount ?? 200, 'scanCount', GAP_LIMIT, 200);
    let gap = 0;
    let scanNextIndex = startIndex;
    let nextIndex = 0;
    const wallets = [];
    for (let scanned = 0; scanned < scanCount && scanNextIndex <= MAX_INDEX; scanned++) {
        const wallet = deriveAddress(context, scanNextIndex);
        scanNextIndex = wallet.index + 1;
        if (isUsed(wallet.address)) {
            wallets.push(wallet);
            nextIndex = scanNextIndex;
            gap = 0;
        } else {
            gap++;
            if (startIndex === 0 && wallet.index === 0) wallets.push(wallet);
        }
        if (gap >= GAP_LIMIT) break;
    }
    return { root: context.root, wallets, nextIndex: Math.max(nextIndex, startIndex === 0 ? 1 : 0),
        scanNextIndex, gapLimit: GAP_LIMIT, stoppedAtGap: gap >= GAP_LIMIT,
        exhausted: scanNextIndex > MAX_INDEX };
}

module.exports = { HD_SCHEME, HD_BASE_PATH, MAX_INDEX, MAX_BATCH, GAP_LIMIT, integer,
    validateScheme, createHdContext, deriveAddress, deriveAddresses, discoverAddresses };
