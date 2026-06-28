// ============================================================
// 助记词模块单元测试
// 覆盖: generateMnemonic, validateMnemonic, mnemonicToWallet
// ============================================================
const { generateMnemonic, validateMnemonic, mnemonicToWallet } = require('../../src/core');

// ============================================================
// 第1组: generateMnemonic 助记词生成
// ============================================================
describe('generateMnemonic', () => {
    it('默认 128 位 → 12 个单词', () => {
        const mnemonic = generateMnemonic();
        const words = mnemonic.split(' ');
        expect(words.length).toBe(12);
    });

    it('256 位 → 24 个单词', () => {
        const mnemonic = generateMnemonic(256);
        const words = mnemonic.split(' ');
        expect(words.length).toBe(24);
    });

    it('生成的助记词是有效的英文单词（均来自 BIP39 词表）', () => {
        const mnemonic = generateMnemonic();
        const words = mnemonic.split(' ');
        // 至少通过 validateMnemonic 验证
        expect(validateMnemonic(mnemonic)).toBe(true);
    });

    it('两次调用 generateMnemonic 产生不同的助记词（随机性）', () => {
        const m1 = generateMnemonic();
        const m2 = generateMnemonic();
        expect(m1).not.toBe(m2);
    });

    it('128 位强度（默认）可被 validateMnemonic 验证通过', () => {
        const mnemonic = generateMnemonic(128);
        expect(validateMnemonic(mnemonic)).toBe(true);
    });
});

// ============================================================
// 第2组: validateMnemonic 助记词验证
// ============================================================
describe('validateMnemonic', () => {
    it('合法助记词 → 返回 true', () => {
        const mnemonic = generateMnemonic();
        expect(validateMnemonic(mnemonic)).toBe(true);
    });

    it('非法单词 → 返回 false', () => {
        expect(validateMnemonic('apple banana cherry invalidword here test test test test test test test')).toBe(false);
    });

    it('空字符串 → 返回 false', () => {
        expect(validateMnemonic('')).toBe(false);
    });

    it('太短（少于 12 词）→ 返回 false', () => {
        expect(validateMnemonic('apple banana cherry')).toBe(false);
    });

    it('单词数正确但校验和错误 → 返回 false', () => {
        // 使用词表中的合法单词但顺序不对（校验和会失败）
        expect(validateMnemonic('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo')).toBe(false);
    });

    it('null/undefined → 返回 false', () => {
        expect(validateMnemonic(null)).toBe(false);
        expect(validateMnemonic(undefined)).toBe(false);
    });
});

// ============================================================
// 第3组: mnemonicToWallet 确定性验证（高优先级）
// ============================================================
describe('mnemonicToWallet 确定性', () => {
    const knownMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    it('相同助记词 + 相同密码 → 完全相同的结果', () => {
        const wallet1 = mnemonicToWallet(knownMnemonic, 'password');
        const wallet2 = mnemonicToWallet(knownMnemonic, 'password');

        expect(wallet1.privateKey).toBe(wallet2.privateKey);
        expect(wallet1.publicKey).toBe(wallet2.publicKey);
        expect(wallet1.address).toBe(wallet2.address);
        expect(wallet1.mnemonic).toBe(wallet2.mnemonic);
    });

    it('相同助记词 + 无密码 → 每次结果相同', () => {
        const wallet1 = mnemonicToWallet(knownMnemonic);
        const wallet2 = mnemonicToWallet(knownMnemonic);

        expect(wallet1.privateKey).toBe(wallet2.privateKey);
        expect(wallet1.publicKey).toBe(wallet2.publicKey);
        expect(wallet1.address).toBe(wallet2.address);
    });

    it('不同密码 → 不同钱包（私钥不同）', () => {
        const wallet1 = mnemonicToWallet(knownMnemonic, 'password1');
        const wallet2 = mnemonicToWallet(knownMnemonic, 'password2');

        expect(wallet1.privateKey).not.toBe(wallet2.privateKey);
        expect(wallet1.address).not.toBe(wallet2.address);
    });

    it('无密码 vs 空字符串密码 → 结果相同', () => {
        const wallet1 = mnemonicToWallet(knownMnemonic);
        const wallet2 = mnemonicToWallet(knownMnemonic, '');
        const wallet3 = mnemonicToWallet(knownMnemonic, undefined);

        expect(wallet1.privateKey).toBe(wallet2.privateKey);
        expect(wallet1.privateKey).toBe(wallet3.privateKey);
    });

    it('助记词带多余空格 → 规范化后结果一致', () => {
        const normal = mnemonicToWallet(knownMnemonic);
        const spaced = mnemonicToWallet('  abandon   abandon   abandon   abandon   abandon   abandon   abandon   abandon   abandon   abandon   abandon   about  ');

        expect(normal.privateKey).toBe(spaced.privateKey);
        expect(normal.address).toBe(spaced.address);
    });

    it('助记词大写 → 转小写后结果一致', () => {
        const normal = mnemonicToWallet(knownMnemonic);
        const upper = mnemonicToWallet(knownMnemonic.toUpperCase());

        expect(normal.privateKey).toBe(upper.privateKey);
        expect(normal.address).toBe(upper.address);
    });

    it('返回结构包含 privateKey, publicKey, address, mnemonic', () => {
        const wallet = mnemonicToWallet(knownMnemonic, 'test');

        expect(wallet).toHaveProperty('privateKey');
        expect(wallet).toHaveProperty('publicKey');
        expect(wallet).toHaveProperty('address');
        expect(wallet).toHaveProperty('mnemonic');
        expect(typeof wallet.privateKey).toBe('string');
        expect(typeof wallet.publicKey).toBe('string');
        expect(typeof wallet.address).toBe('string');
        // privateKey 是 PEM 格式
        expect(wallet.privateKey).toContain('-----BEGIN PRIVATE KEY-----');
    });

    it('助记词与返回中的助记词一致', () => {
        const wallet = mnemonicToWallet(knownMnemonic);
        expect(wallet.mnemonic).toBe(knownMnemonic);
    });

    // --- 边界 ---
    it('无效助记词 → 抛出错误', () => {
        expect(() => mnemonicToWallet('invalid mnemonic phrase here')).toThrow();
    });

    it('空字符串助记词 → 抛出错误', () => {
        expect(() => mnemonicToWallet('')).toThrow();
    });

    it('null 助记词 → 抛出错误', () => {
        expect(() => mnemonicToWallet(null)).toThrow();
    });
});