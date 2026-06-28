// StarCoin 统一错误处理：AppError + wrapAsync + 404/错误中间件

const logger = require('../logger');

/**
 * 自定义应用错误类
 * 在路由中抛出即可被 errorMiddleware 捕获并格式化返回
 *
 * @example
 *   throw new AppError(400, '余额不足', 'INSUFFICIENT_BALANCE');
 *   throw new AppError(400, '参数错误', 'INVALID_PARAMS', { field: 'amount' });
 */
class AppError extends Error {
    /**
     * @param {number} statusCode - HTTP 状态码（4xx / 5xx）
     * @param {string} message    - 人类可读的错误描述
     * @param {string} [code]     - 机器可读的错误码（如 'INVALID_PARAMS'），默认根据 statusCode 推导
     * @param {object} [details]  - 额外详细数据（可选）
     */
    constructor(statusCode, message, code, details) {
        super(message);
        this.name = 'AppError';
        this.statusCode = statusCode;
        this.code = code || _defaultCode(statusCode);
        this.details = details || null;
    }
}

function _defaultCode(statusCode) {
    if (statusCode >= 500) return 'INTERNAL_ERROR';
    if (statusCode === 404) return 'NOT_FOUND';
    if (statusCode === 401) return 'UNAUTHORIZED';
    if (statusCode === 403) return 'FORBIDDEN';
    if (statusCode === 409) return 'CONFLICT';
    return 'BAD_REQUEST';
}

/** 包装 async 路由，自动捕获异常并返回统一 JSON 错误 */
function wrapAsync(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(err => {
            if (res.headersSent) {
                // 响应已部分发送（如 SSE 流），传给 Express 默认错误处理器
                return next(err);
            }
            // 直接发送统一 JSON 错误响应
            const body = _formatErrorResponse(err);
            res.status(body.statusCode).json(body);
        });
    };
}

/**
 * 内部：将各种错误类型统一为 JSON 响应体
 * 被 wrapAsync 和 createErrorMiddleware 共用
 */
function _formatErrorResponse(err) {
    let statusCode = 500;
    let message = '服务器内部错误';
    let code = 'INTERNAL_ERROR';
    let details = null;

    if (err instanceof AppError) {
        statusCode = err.statusCode;
        message = err.message;
        code = err.code;
        details = err.details;
    } else if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        statusCode = 400;
        message = '请求体 JSON 格式错误: ' + err.message;
        code = 'INVALID_JSON';
    } else if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
        statusCode = err.statusCode;
        message = err.message || message;
    } else if (err.code === 'EBADCSRF' || err.code === 'ECONNABORTED') {
        statusCode = 400;
        message = err.message;
        code = err.code;
    } else if (err.code === 'ERR_ASSERTION') {
        // 断言错误也归为 400
        statusCode = 400;
        message = err.message;
        code = 'VALIDATION_ERROR';
    } else {
        statusCode = err.statusCode || 500;
        message = statusCode >= 500 ? '服务器内部错误' : (err.message || '未知错误');
        code = err.code || 'INTERNAL_ERROR';
    }

    const body = {
        success: false,
        error: message,
        code: code,
        statusCode: statusCode
    };
    if (details) {
        body.details = details;
    }
    // 非生产环境且为 5xx 时附带 stack（便于调试）
    if (statusCode >= 500 && process.env.NODE_ENV !== 'production') {
        body.stack = err.stack;
    }
    return body;
}

/**
 * 创建 404 兜底中间件
 * 放在所有路由之后，捕获未匹配的请求路径
 *
 * @returns {function} Express 中间件
 */
function createNotFoundMiddleware() {
    return (req, res) => {
        res.status(404).json({
            success: false,
            error: `接口不存在: ${req.method} ${req.originalUrl}`,
            code: 'NOT_FOUND',
            statusCode: 404
        });
    };
}

/**
 * 创建统一错误处理中间件
 * 放在所有路由和 404 中间件之后
 * 作为兜底安全网，捕获所有未被 wrapAsync 处理的错误
 *
 * @param {object} [options]            - 可选配置
 * @param {boolean} [options.logErrors] - 是否打印错误日志（默认 true）
 * @returns {function} Express 错误处理中间件 (err, req, res, next)
 */
function createErrorMiddleware(options = {}) {
    const { logErrors = true } = options;

    // Express 错误中间件必须有 4 个参数
    return (err, req, res, _next) => {
        // 如果响应已发送（wrapAsync 已处理），则不再处理
        if (res.headersSent) {
            return;
        }

        if (logErrors) {
            _logError(err, req);
        }

        const body = _formatErrorResponse(err);
        res.status(body.statusCode).json(body);
    };
}

/**
 * 内部：格式化错误日志
 */
function _logError(err, req) {
    const timestamp = new Date().toISOString();
    const method = req.method || '?';
    const url = req.originalUrl || req.url || '?';
    const log = logger.module('HTTP');

    if (err instanceof AppError && err.statusCode < 500) {
        // 4xx 业务错误：只打印简略信息
        log.warn('请求处理错误', { method, url, statusCode: err.statusCode, message: err.message });
    } else {
        // 5xx 或非预期错误：打印完整堆栈
        log.error('服务器错误', { method, url, message: err.message, stack: err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : undefined });
    }
}

module.exports = {
    AppError,
    wrapAsync,
    createNotFoundMiddleware,
    createErrorMiddleware
};