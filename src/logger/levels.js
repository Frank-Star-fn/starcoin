/**
 * 日志级别常量
 *
 * 数值越小优先级越高（越详细）。
 * 设置 LOG_LEVEL=info 时，仅输出数值 <= INFO 的日志。
 */

const LEVELS = {
    DEBUG: { value: 0, label: 'DEBUG', emoji: '🔍' },
    INFO:  { value: 1, label: 'INFO',  emoji: 'ℹ️' },
    WARN:  { value: 2, label: 'WARN',  emoji: '⚠️' },
    ERROR: { value: 3, label: 'ERROR', emoji: '❌' },
};

// 按名称快速查找
const LEVEL_MAP = {};
for (const [name, def] of Object.entries(LEVELS)) {
    LEVEL_MAP[name] = def;
    LEVEL_MAP[name.toLowerCase()] = def;
}

/**
 * 根据名称获取级别定义，不区分大小写
 * @param {string} name - 级别名称（如 'info', 'INFO', 'warn'）
 * @returns {{ value: number, label: string, emoji: string }|null}
 */
function getLevel(name) {
    if (!name || typeof name !== 'string') return null;
    return LEVEL_MAP[name.trim().toUpperCase()] || LEVEL_MAP[name.trim().toLowerCase()] || null;
}

/**
 * 判断给定的级别是否应该被输出（currentValue <= thresholdValue）
 * @param {number} levelValue - 当前日志级别数值
 * @param {number} thresholdValue - 阈值级别数值
 * @returns {boolean}
 */
function shouldLog(levelValue, thresholdValue) {
    return levelValue >= thresholdValue;
}

module.exports = { LEVELS, getLevel, shouldLog };