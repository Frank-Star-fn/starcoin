/* ============================================================
   wallet-utils.js — 钱包工具函数（纯函数，无 DOM 依赖）
   ============================================================ */

/**
 * 支持的币种符号列表
 * 多处共用：余额显示、转账表单、水龙头等
 */
const CURRENCY_SYMBOLS = ['STC', 'cBTC', 'cETH'];

/**
 * 格式化余额：保留 6 位小数，去除多余的尾随零
 * @param {number|string} num
 * @returns {string}
 */
function formatBalance(num) {
    if (num === undefined || num === null || isNaN(Number(num))) return '0';
    return Number(num).toFixed(6).replace(/\.?0+$/, '');
}

/**
 * 渲染多币种余额 HTML
 * - 余额 > 0 的币种显示绿色
 * - 余额 < 0 的币种显示红色
 * - 余额 == 0 的币种显示灰色小字
 * - 如果有锁定奖励，附加 🔒 锁定中 标记
 *
 * @param {Object|null} balances  - 多币种余额对象，如 { STC: 100, cBTC: 0.01 }
 * @param {Object|number|null} lockedRewardsObj - 锁定奖励（对象或数值）
 * @returns {string} HTML 字符串
 */
function formatMultiCurrencyBalances(balances, lockedRewardsObj) {
    if (!balances) return '余额: --';
    const parts = [];
    for (const cur of CURRENCY_SYMBOLS) {
        const bal = Number(balances[cur]) || 0;
        const balStr = formatBalance(bal);
        if (bal > 0) {
            parts.push(`<span style="color:#4ade80;">${balStr} ${cur}</span>`);
        } else if (bal < 0) {
            parts.push(`<span style="color:#f87171;">${balStr} ${cur}</span>`);
        } else {
            parts.push(`<span style="color:#6b7280;">${balStr} ${cur}</span>`);
        }
    }
    let html = '余额: ' + parts.join(' &nbsp;|&nbsp; ');

    // 锁定奖励（目前只有 STC 有锁定，来自矿工奖励）
    if (lockedRewardsObj && typeof lockedRewardsObj === 'object') {
        const totalLocked = Object.values(lockedRewardsObj).reduce((s, v) => s + (Number(v) || 0), 0);
        if (totalLocked > 0) {
            html += ` <span style="color:#fbbf24;font-size:11px;">🔒 锁定中</span>`;
        }
    } else if (typeof lockedRewardsObj === 'number' && lockedRewardsObj > 0) {
        html += ` <span style="color:#fbbf24;font-size:11px;">🔒 +${formatBalance(lockedRewardsObj)} 锁定</span>`;
    }
    return html;
}