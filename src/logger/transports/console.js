/**
 * Console 传输器
 * 输出带颜色的日志到 stdout/stderr。
 *
 * 颜色映射：
 *   DEBUG → 灰色
 *   INFO  → 绿色
 *   WARN  → 黄色
 *   ERROR → 红色（输出到 stderr）
 */

const { LEVELS } = require('../levels');
const basicFormatter = require('../formatters/basic');

// ANSI 颜色码
const COLORS = {
    DEBUG: '\x1b[90m',     // 灰色
    INFO:  '\x1b[32m',     // 绿色
    WARN:  '\x1b[33m',     // 黄色
    ERROR: '\x1b[31m',     // 红色
    RESET: '\x1b[0m',      // 重置
};

/**
 * Console 传输器
 * @param {object} options
 * @param {string} [options.level] - 最低输出级别（默认继承全局配置）
 */
class ConsoleTransport {
    constructor(options = {}) {
        this.name = 'console';
        this.level = options.level || null; // null 表示继承全局
    }

    /**
     * 输出一条日志
     * @param {object} record - 日志记录
     */
    log(record) {
        const color = COLORS[record.level] || COLORS.INFO;
        const reset = COLORS.RESET;

        // 基础文本格式化
        const line = basicFormatter.format(record);
        const coloredLine = `${color}${line}${reset}`;

        // ERROR 输出到 stderr，其余到 stdout
        if (record.level === 'ERROR') {
            process.stderr.write(coloredLine + '\n');
        } else {
            process.stdout.write(coloredLine + '\n');
        }
    }
}

module.exports = { ConsoleTransport };