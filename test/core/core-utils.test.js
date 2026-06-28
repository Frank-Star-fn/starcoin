// ============================================================
// 核心工具函数单元测试
// 覆盖: normalizeCurrency, effectiveCurrency
// ============================================================
const { normalizeCurrency, effectiveCurrency, SUPPORTED_CURRENCIES, DEFAULT_CURRENCY } = require('../../src/core');

// ============================================================
// 第1组: normalizeCurrency 币种规范化
// ============================================================
describe('normalizeCurrency', () => {
    // --- 标准币种 ---
    it('STC → 返回 STC', () => {
        expect(normalizeCurrency('STC')).toBe('STC');
    });

    it('小写 stc → 返回 STC（大小写不敏感）', () => {
        expect(normalizeCurrency('stc')).toBe('STC');
    });

    it('cBTC → 返回 cBTC', () => {
        expect(normalizeCurrency('cBTC')).toBe('cBTC');
    });

    it('cETH → 返回 cETH', () => {
        expect(normalizeCurrency('cETH')).toBe('cETH');
    });

    // --- 旧币种迁移 ---
    it('旧名 WBTC → 返回 cBTC', () => {
        expect(normalizeCurrency('WBTC')).toBe('cBTC');
    });

    it('旧名 wbtc（小写）→ 返回 cBTC', () => {
        expect(normalizeCurrency('wbtc')).toBe('cBTC');
    });

    it('旧名 WETH → 返回 cETH', () => {
        expect(normalizeCurrency('WETH')).toBe('cETH');
    });

    it('旧名 weth（小写）→ 返回 cETH', () => {
        expect(normalizeCurrency('weth')).toBe('cETH');
    });

    // --- 非法值 ---
    it('不支持的币种 XXX → 返回 undefined', () => {
        expect(normalizeCurrency('XXX')).toBeUndefined();
    });

    it('BTC（不是 cBTC）→ 返回 undefined', () => {
        expect(normalizeCurrency('BTC')).toBeUndefined();
    });

    it('ETH（不是 cETH）→ 返回 undefined', () => {
        expect(normalizeCurrency('ETH')).toBeUndefined();
    });

    // --- 边界 ---
    it('null → 返回 undefined', () => {
        expect(normalizeCurrency(null)).toBeUndefined();
    });

    it('undefined → 返回 undefined', () => {
        expect(normalizeCurrency(undefined)).toBeUndefined();
    });

    it('空字符串 → 返回 undefined', () => {
        expect(normalizeCurrency('')).toBeUndefined();
    });

    it('非字符串类型（数字）→ 返回 undefined', () => {
        expect(normalizeCurrency(123)).toBeUndefined();
    });

    it('带空格的输入被正确 trim', () => {
        expect(normalizeCurrency('  STC  ')).toBe('STC');
        expect(normalizeCurrency('  cbtc  ')).toBe('cBTC');
        expect(normalizeCurrency('  wbtc  ')).toBe('cBTC');
    });

    it('大小写混合 StC → 返回 STC', () => {
        expect(normalizeCurrency('StC')).toBe('STC');
    });
});

// ============================================================
// 第2组: effectiveCurrency 有效币种
// ============================================================
describe('effectiveCurrency', () => {
    // --- 对象参数 ---
    it('交易对象有 currency=STC → 返回 STC', () => {
        expect(effectiveCurrency({ currency: 'STC' })).toBe('STC');
    });

    it('交易对象有 currency=cBTC → 返回 cBTC', () => {
        expect(effectiveCurrency({ currency: 'cBTC' })).toBe('cBTC');
    });

    it('交易对象有 currency=cETH → 返回 cETH', () => {
        expect(effectiveCurrency({ currency: 'cETH' })).toBe('cETH');
    });

    it('交易对象无 currency 字段 → 返回默认 STC', () => {
        expect(effectiveCurrency({})).toBe('STC');
        expect(effectiveCurrency({ amount: 10 })).toBe('STC');
    });

    it('交易对象有 currency=undefined → 返回默认 STC', () => {
        expect(effectiveCurrency({ currency: undefined })).toBe('STC');
    });

    // --- 对象参数: 旧币种迁移 ---
    it('交易对象有旧名 WBTC → 返回 cBTC', () => {
        expect(effectiveCurrency({ currency: 'WBTC' })).toBe('cBTC');
    });

    it('交易对象有旧名 weth（小写）→ 返回 cETH', () => {
        expect(effectiveCurrency({ currency: 'weth' })).toBe('cETH');
    });

    it('交易对象有非法币种 → 返回默认 STC', () => {
        expect(effectiveCurrency({ currency: 'XXX' })).toBe('STC');
    });

    // --- 字符串参数 ---
    it('字符串 STC → 返回 STC', () => {
        expect(effectiveCurrency('STC')).toBe('STC');
    });

    it('字符串 stc（小写）→ 返回 STC', () => {
        expect(effectiveCurrency('stc')).toBe('STC');
    });

    it('字符串 cbtc → 返回 cBTC', () => {
        expect(effectiveCurrency('cbtc')).toBe('cBTC');
    });

    it('字符串 WBTC → 返回 cBTC（迁移）', () => {
        expect(effectiveCurrency('WBTC')).toBe('cBTC');
    });

    it('字符串 XXX（非法）→ 返回默认 STC', () => {
        expect(effectiveCurrency('XXX')).toBe('STC');
    });

    // --- 边界参数 ---
    it('null → 返回默认 STC', () => {
        expect(effectiveCurrency(null)).toBe('STC');
    });

    it('undefined → 返回默认 STC', () => {
        expect(effectiveCurrency(undefined)).toBe('STC');
    });

    it('空字符串 → 返回默认 STC', () => {
        expect(effectiveCurrency('')).toBe('STC');
    });

    // --- Transaction 实例 ---
    it('Transaction 实例 currency=STC → 返回 STC', () => {
        const { Transaction } = require('../../src/core');
        const tx = new Transaction('A', 'B', 10, 0, '', 'STC');
        expect(effectiveCurrency(tx)).toBe('STC');
    });

    it('Transaction 实例 currency=WBTC → 被 normalize 为 cBTC', () => {
        const { Transaction } = require('../../src/core');
        const tx = new Transaction('A', 'B', 10, 0, '', 'WBTC');
        expect(effectiveCurrency(tx)).toBe('cBTC');
    });

    it('Transaction 实例 currency=undefined → 返回默认 STC', () => {
        const { Transaction } = require('../../src/core');
        const tx = new Transaction('A', 'B', 10, 0, '', undefined);
        expect(effectiveCurrency(tx)).toBe('STC');
    });

    it('Transaction 实例无 currency 参数 → 返回默认 STC', () => {
        const { Transaction } = require('../../src/core');
        const tx = new Transaction('A', 'B', 10);
        expect(effectiveCurrency(tx)).toBe('STC');
    });
});