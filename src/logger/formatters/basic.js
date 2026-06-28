/**
 * 基础文本格式化器
 * 输出人类可读的日志行，如：
 *   [2026-06-28 10:30:15.123] [INFO]  [P2P模块]  🔗 已连接到对等节点
 */

/**
 * 格式化时间戳
 * @param {Date} date
 * @returns {string} 格式: YYYY-MM-DD HH:mm:ss.mmm
 */
function formatTime(date) {
    const d = date || new Date();
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * 格式化一条日志记录为纯文本
 * @param {object} record - 日志记录对象
 * @param {string} record.time - ISO 时间字符串
 * @param {string} record.level - 级别标签
 * @param {string} record.module - 模块名
 * @param {string} record.message - 日志消息
 * @param {object} [record.ctx] - 上下文数据
 * @returns {string} 格式化后的文本行
 */
function format(record) {
    const time = formatTime(new Date(record.time));
    const level = record.level.padEnd(5);
    const mod = record.module ? `[${record.module}]`.padEnd(16) : ''.padEnd(16);
    let line = `[${time}] [${level}] ${mod} ${record.message}`;

    // 如果有关联的上下文数据，追加在行尾
    if (record.ctx && typeof record.ctx === 'object' && Object.keys(record.ctx).length > 0) {
        const ctxStr = Object.entries(record.ctx)
            .map(([k, v]) => {
                const val = typeof v === 'object' ? JSON.stringify(v) : v;
                return `${k}=${val}`;
            })
            .join(' ');
        line += `  (${ctxStr})`;
    }

    return line;
}

module.exports = { format, formatTime };