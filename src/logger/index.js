/**
 * StarCoin 日志系统入口
 *
 * 用法：
 *   const logger = require('./logger');
 *   logger.info('模块名', '消息内容');
 *   logger.warn('模块名', '消息内容', { key: 'val' });  // 带上下文
 *   logger.error('模块名', '消息内容', err);
 *
 *   // 带模块前缀的快捷方式（推荐）：
 *   const log = logger.module('P2P模块');
 *   log.info('已连接到对等节点');
 */

const { LEVELS, getLevel, shouldLog } = require('./levels');
const { ConsoleTransport } = require('./transports/console');
const { FileTransport } = require('./transports/file');

// ============================================================
// 默认配置（可由 config.js 覆盖）
// ============================================================
const DEFAULT_CONFIG = {
    level: 'INFO',
    transport: 'console',   // 'console' | 'file' | 'both'
    file: {
        dir: null,          // null → 使用默认 ./logs
        maxSize: 10 * 1024 * 1024,
        maxFiles: 5,
        json: false,
    },
};

// ============================================================
// Logger 类
// ============================================================
class Logger {
    /**
     * @param {object} [options] - 配置项
     * @param {string} [options.level] - 日志级别
     * @param {string} [options.transport] - 传输方式
     * @param {object} [options.file] - 文件传输配置
     */
    constructor(options = {}) {
        this._config = _mergeConfig(DEFAULT_CONFIG, options);
        this._transports = [];
        this._moduleTransports = new Map(); // 模块级别覆盖
        this._initTransports();

        // 绑定快捷方法
        this.debug = this._makeLogMethod(LEVELS.DEBUG);
        this.info = this._makeLogMethod(LEVELS.INFO);
        this.warn = this._makeLogMethod(LEVELS.WARN);
        this.error = this._makeLogMethod(LEVELS.ERROR);
    }

    /** 获取当前日志级别数值 */
    get levelValue() {
        const def = getLevel(this._config.level);
        return def ? def.value : LEVELS.INFO.value;
    }

    /** 初始化传输器 */
    _initTransports() {
        const transport = this._config.transport || 'console';
        const transports = transport === 'both' ? ['console', 'file'] : [transport];

        for (const name of transports) {
            if (name === 'console') {
                this._transports.push(new ConsoleTransport());
            } else if (name === 'file') {
                this._transports.push(new FileTransport(this._config.file));
            }
        }
    }

    /**
     * 创建日志快捷方法（debug / info / warn / error）
     * @param {{ value: number, label: string, emoji: string }} levelDef
     * @returns {function}
     */
    _makeLogMethod(levelDef) {
        const self = this;
        return function logMethod(moduleOrMsg, msgOrCtx, ctxOrUndefined) {
            self._log(levelDef, moduleOrMsg, msgOrCtx, ctxOrUndefined);
        };
    }

    /**
     * 内部日志记录方法
     *
     * 支持两种调用风格：
     *   1. logger.info('模块名', '消息', { ctx });
     *   2. logger.info('消息');  // 无模块名
     *
     * @param {{ value: number, label: string, emoji: string }} levelDef
     * @param {string} moduleOrMsg - 模块名 或 消息
     * @param {string|object} msgOrCtx - 消息 或 上下文对象
     * @param {object} [ctx] - 上下文对象
     */
    _log(levelDef, moduleOrMsg, msgOrCtx, ctx) {
        // 级别过滤
        if (!shouldLog(levelDef.value, this.levelValue)) {
            return;
        }

        // 解析参数
        let moduleName = '';
        let message = '';
        let context = null;

        if (arguments.length === 2) {
            // logger.info('消息')
            message = String(moduleOrMsg);
        } else if (arguments.length === 3) {
            // logger.info('模块名', '消息') 或 logger.info('消息', err)
            if (typeof msgOrCtx === 'string') {
                moduleName = String(moduleOrMsg);
                message = msgOrCtx;
            } else {
                message = String(moduleOrMsg);
                context = _normalizeCtx(msgOrCtx);
            }
        } else {
            // logger.info('模块名', '消息', { ctx })
            moduleName = String(moduleOrMsg);
            message = String(msgOrCtx);
            context = _normalizeCtx(ctx);
        }

        // 构造日志记录
        const record = {
            time: new Date().toISOString(),
            level: levelDef.label,
            emoji: levelDef.emoji,
            module: moduleName,
            message: message,
            ctx: context,
        };

        // 写入所有传输器
        for (const transport of this._transports) {
            try {
                transport.log(record);
            } catch (err) {
                // 传输器失败时 fallback 到 stderr
                process.stderr.write(`[Logger] 传输器 ${transport.name} 写入失败: ${err.message}\n`);
            }
        }
    }

    /**
     * 创建带模块前缀的 logger 实例
     *
     * @param {string} moduleName - 模块名称
     * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
     *
     * @example
     *   const log = logger.module('P2P');
     *   log.info('已连接');  // 自动带上 [P2P] 前缀
     */
    module(moduleName) {
        const self = this;
        return {
            debug: (msg, ctx) => self._log(LEVELS.DEBUG, moduleName, msg, ctx),
            info:  (msg, ctx) => self._log(LEVELS.INFO, moduleName, msg, ctx),
            warn:  (msg, ctx) => self._log(LEVELS.WARN, moduleName, msg, ctx),
            error: (msg, ctx) => self._log(LEVELS.ERROR, moduleName, msg, ctx),
        };
    }

    /**
     * 动态更新配置
     * @param {object} options
     */
    configure(options = {}) {
        if (options.level) {
            this._config.level = options.level;
        }
        if (options.transport) {
            this._config.transport = options.transport;
            // 重新初始化传输器
            this._transports = [];
            this._initTransports();
        }
    }

    /** 获取当前配置（只读副本） */
    get config() {
        return { ...this._config };
    }
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 合并用户配置与默认配置
 */
function _mergeConfig(defaults, user) {
    const result = { ...defaults };
    if (user.level) result.level = user.level;
    if (user.transport) result.transport = user.transport;
    if (user.file) {
        result.file = { ...result.file, ...user.file };
    }
    return result;
}

/**
 * 规范化上下文对象
 * - Error 对象 → 提取 message + stack
 * - 普通对象 → 直接使用
 * - 其他 → 包装为 { value }
 */
function _normalizeCtx(ctx) {
    if (!ctx) return null;
    if (ctx instanceof Error) {
        return { error: ctx.message, stack: ctx.stack };
    }
    if (typeof ctx === 'object') {
        return ctx;
    }
    return { value: ctx };
}

// ============================================================
// 默认全局实例（单例）
// ============================================================
const defaultLogger = new Logger();

// 导出
module.exports = defaultLogger;
module.exports.Logger = Logger;