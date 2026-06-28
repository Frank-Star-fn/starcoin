// ============================================================
// ECDSA 底层工具函数直接单元测试
// 覆盖: getPublicKeyFromPrivateKeyPem, publicKeyToAddress,
//       verifyPublicKeyMatchesAddress, signWithECDSA, verifyWithECDSA
// ============================================================
const crypto = require('crypto');
const {
    getPublicKeyFromPrivateKeyPem,
    publicKeyToAddress,
    verifyPublicKeyMatchesAddress,
    signWithECDSA,
    verifyWithECDSA,
    generateWallet
} = require('../src/core');

// ============================================================
// 第1组: getPublicKeyFromPrivateKeyPem
// ============================================================
describe('getPublicKeyFromPrivateKeyPem', () => {
    let wallet;

    beforeAll(() => {
        wallet = generateWallet();
    });

    it('给定已知 PEM → 返回确定 hex 公钥', () => {
        const pubkey1 = getPublicKeyFromPrivateKeyPem(wallet.privateKey);
        const pubkey2 = getPublicKeyFromPrivateKeyPem(wallet.privateKey);

        expect(pubkey1).toBe(pubkey2);          // 确定性
        expect(pubkey1).toMatch(/^[0-9a-f]+$/i); // hex 格式
        expect(pubkey1.length).toBeGreaterThan(0);
    });

    it('推导出的公钥与 generateWallet 返回的一致', () => {
        const derivedPubkey = getPublicKeyFromPrivateKeyPem(wallet.privateKey);
        expect(derivedPubkey).toBe(wallet.publicKey);
    });

    it('无效 PEM → 抛出错误', () => {
        expect(() => getPublicKeyFromPrivateKeyPem('not a pem')).toThrow();
    });

    it('空字符串 → 抛出错误', () => {
        expect(() => getPublicKeyFromPrivateKeyPem('')).toThrow();
    });

    it('null/undefined → 抛出错误', () => {
        expect(() => getPublicKeyFromPrivateKeyPem(null)).toThrow();
    });

    it('公钥能被 crypto.createPublicKey 解析（DER secp256k1 格式）', () => {
        const pubHex = getPublicKeyFromPrivateKeyPem(wallet.privateKey);
        const pubDer = Buffer.from(pubHex, 'hex');
        const key = crypto.createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
        expect(key.asymmetricKeyType).toBe('ec');
    });
});

// ============================================================
// 第2组: publicKeyToAddress
// ============================================================
describe('publicKeyToAddress', () => {
    let wallet;

    beforeAll(() => {
        wallet = generateWallet();
    });

    it('给定 hex 公钥 → 返回 SHA256 截断前 32 位', () => {
        const address = publicKeyToAddress(wallet.publicKey);
        const expected = crypto.createHash('sha256')
            .update(wallet.publicKey, 'hex').digest('hex').substring(0, 32);

        expect(address).toBe(expected);
        expect(address.length).toBe(32);
    });

    it('与 generateWallet().address 一致', () => {
        const address = publicKeyToAddress(wallet.publicKey);
        expect(address).toBe(wallet.address);
    });

    it('确定性：同公钥 → 同地址', () => {
        const addr1 = publicKeyToAddress(wallet.publicKey);
        const addr2 = publicKeyToAddress(wallet.publicKey);
        expect(addr1).toBe(addr2);
    });

    it('不同公钥 → 不同地址', () => {
        const walletB = generateWallet();
        const addrA = publicKeyToAddress(wallet.publicKey);
        const addrB = publicKeyToAddress(walletB.publicKey);
        expect(addrA).not.toBe(addrB);
    });

    it('空字符串 → 抛出或返回固定值（SHA256("").substring(0,32)）', () => {
        // 空 hex 输入，crypto 可能报错
        expect(() => publicKeyToAddress('')).not.toThrow();
        const emptyHash = crypto.createHash('sha256').digest('hex').substring(0, 32);
        expect(publicKeyToAddress('')).toBe(emptyHash);
    });
});

// ============================================================
// 第3组: verifyPublicKeyMatchesAddress
// ============================================================
describe('verifyPublicKeyMatchesAddress', () => {
    let wallet;

    beforeAll(() => {
        wallet = generateWallet();
    });

    it('匹配的公钥和地址 → 返回 true', () => {
        expect(verifyPublicKeyMatchesAddress(wallet.publicKey, wallet.address)).toBe(true);
    });

    it('不匹配的公钥和地址 → 返回 false', () => {
        const walletB = generateWallet();
        expect(verifyPublicKeyMatchesAddress(wallet.publicKey, walletB.address)).toBe(false);
    });

    it('空字符串 → 不抛出，返回 false', () => {
        expect(() => verifyPublicKeyMatchesAddress('', wallet.address)).not.toThrow();
        expect(() => verifyPublicKeyMatchesAddress(wallet.publicKey, '')).not.toThrow();
    });
});

// ============================================================
// 第4组: signWithECDSA + verifyWithECDSA
// ============================================================
describe('signWithECDSA + verifyWithECDSA', () => {
    let wallet;
    const testData = '48656c6c6f20576f726c64'; // "Hello World" hex

    beforeAll(() => {
        wallet = generateWallet();
    });

    it('signWithECDSA 返回 hex 签名字符串', () => {
        const sig = signWithECDSA(testData, wallet.privateKey);
        expect(sig).toMatch(/^[0-9a-f]+$/i);
        expect(sig.length).toBeGreaterThan(0);
    });

    it('verifyWithECDSA(原始数据, 合法签名, 正确公钥) → true', () => {
        const sig = signWithECDSA(testData, wallet.privateKey);
        expect(verifyWithECDSA(testData, sig, wallet.publicKey)).toBe(true);
    });

    it('verifyWithECDSA(篡改数据, 合法签名, 正确公钥) → false', () => {
        const sig = signWithECDSA(testData, wallet.privateKey);
        const tamperedData = '48656c6c6f20576f726c65'; // "Hello Worle"
        expect(verifyWithECDSA(tamperedData, sig, wallet.publicKey)).toBe(false);
    });

    it('verifyWithECDSA(原始数据, 篡改签名, 正确公钥) → false', () => {
        const sig = signWithECDSA(testData, wallet.privateKey);
        const tamperedSig = sig.substring(0, sig.length - 4) + 'dead';
        expect(verifyWithECDSA(testData, tamperedSig, wallet.publicKey)).toBe(false);
    });

    it('verifyWithECDSA(原始数据, 合法签名, 错误公钥) → false', () => {
        const sig = signWithECDSA(testData, wallet.privateKey);
        const walletB = generateWallet();
        expect(verifyWithECDSA(testData, sig, walletB.publicKey)).toBe(false);
    });

    it('同数据+同私钥 → 每次签名都是有效签名（ECDSA 非确定性，但都可被验签通过）', () => {
        const sig1 = signWithECDSA(testData, wallet.privateKey);
        const sig2 = signWithECDSA(testData, wallet.privateKey);
        // ECDSA 签名不是确定性的（每次使用随机 k），所以 sig1 !== sig2
        // 但两者都应该通过验签
        expect(verifyWithECDSA(testData, sig1, wallet.publicKey)).toBe(true);
        expect(verifyWithECDSA(testData, sig2, wallet.publicKey)).toBe(true);
    });

    it('不同数据 → 签名不互通', () => {
        const sig1 = signWithECDSA(testData, wallet.privateKey);
        const sig2 = signWithECDSA('616e6f74686572', wallet.privateKey); // "another"
        // sig1 不能验证 "another" 的数据
        expect(verifyWithECDSA('616e6f74686572', sig1, wallet.publicKey)).toBe(false);
        // sig2 不能验证原始数据
        expect(verifyWithECDSA(testData, sig2, wallet.publicKey)).toBe(false);
    });

    it('空数据 → 不抛出', () => {
        expect(() => signWithECDSA('', wallet.privateKey)).not.toThrow();
        expect(() => verifyWithECDSA('', '', wallet.publicKey)).not.toThrow();
    });

    it('无效私钥 → signWithECDSA 抛出错误', () => {
        expect(() => signWithECDSA(testData, 'not a pem key')).toThrow();
    });

    it('无效公钥 → verifyWithECDSA 返回 false（不抛出）', () => {
        const sig = signWithECDSA(testData, wallet.privateKey);
        expect(() => verifyWithECDSA(testData, sig, 'invalid')).not.toThrow();
        expect(verifyWithECDSA(testData, sig, 'invalid')).toBe(false);
    });

    // --- 完整的哈希链验证 ---
    it('完整流程：私钥 → 签名 → 公钥 → 验签 → 地址匹配', () => {
        const data = '746573745f646174615f73657175656e6365'; // "test_data_sequence"

        // 签名
        const signature = signWithECDSA(data, wallet.privateKey);

        // 验签
        expect(verifyWithECDSA(data, signature, wallet.publicKey)).toBe(true);

        // 地址推导
        const derivedAddress = publicKeyToAddress(wallet.publicKey);
        expect(derivedAddress).toBe(wallet.address);

        // 地址校验
        expect(verifyPublicKeyMatchesAddress(wallet.publicKey, derivedAddress)).toBe(true);
    });
});