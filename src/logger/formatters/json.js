/**
 * JSON 结构化格式化器
 * 输出 JSON 格式日志行，适合日志收集系统（如 ELK、Loki）
 *
 * 输出示例：
 *   {"time":"2026-06-28T10:30:15.123Z","level":"INFO","module":"P2P模块","msg":"已连接到对等节点","ctx":{"url":"ws://localhost:3001"}}
 */

/**
 * 格式化一条日志记录为 JSON 字符串
 * @param {object} record - 日志记录对象
 * @param {string} record.time - ISO 时间字符串
 * @param {string} record.level - 级别标签
 * @param {string} record.module - 模块名
 * @param {string} record.message - 日志消息
 * @param {object} [record.ctx] - 上下文数据
 * @returns {string} JSON 字符串
 */
function format(record) {
    const payload = {
        time: record.time,
        level: record.level,
        module: record.module || '',
        msg: record.message,
    };
    if (record.ctx && typeof record.ctx === 'object' && Object.keys(record.ctx).length > 0) {
        payload.ctx = record.ctx;
    }
    return JSON.stringify(payload);
}

module.exports = { format };