/**
 * 文件传输器
 * 支持按大小自动轮转（logrotate 风格）。
 *
 * 行为：
 *   - 首次写入时创建日志目录
 *   - 当前文件超过 maxSize 时，重命名为 .1 / .2 / ... 并创建新文件
 *   - 保留最多 maxFiles 个历史文件
 *   - 支持文本格式和 JSON 格式
 */

const fs = require('fs');
const path = require('path');

/**
 * 文件传输器
 * @param {object} options
 * @param {string} options.dir      - 日志目录（默认 ./logs）
 * @param {number} options.maxSize  - 单个文件最大字节数（默认 10MB）
 * @param {number} options.maxFiles - 保留的历史文件数（默认 5）
 * @param {boolean} options.json    - 是否使用 JSON 格式（默认 false）
 */
class FileTransport {
    constructor(options = {}) {
        this.name = 'file';
        this.dir = options.dir || path.join(process.cwd(), 'logs');
        this.maxSize = options.maxSize || 10 * 1024 * 1024; // 10MB
        this.maxFiles = options.maxFiles || 5;
        this.jsonMode = options.json || false;

        this._currentSize = 0;
        this._currentPath = null;
        this._stream = null;

        // 确保目录存在
        this._ensureDir();

        // 打开初始文件流
        this._openStream();
    }

    /** 确保日志目录存在 */
    _ensureDir() {
        try {
            if (!fs.existsSync(this.dir)) {
                fs.mkdirSync(this.dir, { recursive: true });
            }
        } catch (err) {
            console.error(`[Logger] 无法创建日志目录 ${this.dir}: ${err.message}`);
        }
    }

    /** 获取当前日志文件路径（按日期命名） */
    _getLogFilePath() {
        const now = new Date();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        return path.join(this.dir, `starcoin-${dateStr}.log`);
    }

    /** 打开文件流（追加模式） */
    _openStream() {
        try {
            if (this._stream) {
                this._stream.end();
            }
            this._currentPath = this._getLogFilePath();
            this._stream = fs.createWriteStream(this._currentPath, { flags: 'a', encoding: 'utf8' });

            // 获取当前文件大小
            try {
                const stat = fs.statSync(this._currentPath);
                this._currentSize = stat.size;
            } catch {
                this._currentSize = 0;
            }

            this._stream.on('error', (err) => {
                console.error(`[Logger] 文件写入错误: ${err.message}`);
            });
        } catch (err) {
            console.error(`[Logger] 无法打开日志文件: ${err.message}`);
        }
    }

    /** 执行轮转 */
    _rotate() {
        if (!this._stream) return;
        this._stream.end();
        this._stream = null;

        // 将当前文件重命名为 .1
        const basePath = this._currentPath;
        if (fs.existsSync(basePath)) {
            // 先删除最旧的文件，然后依次后移
            const lastPath = `${basePath}.${this.maxFiles}`;
            if (fs.existsSync(lastPath)) {
                try { fs.unlinkSync(lastPath); } catch { /* 忽略 */ }
            }
            for (let i = this.maxFiles - 1; i >= 1; i--) {
                const oldPath = `${basePath}.${i}`;
                const newPath = `${basePath}.${i + 1}`;
                if (fs.existsSync(oldPath)) {
                    try { fs.renameSync(oldPath, newPath); } catch { /* 忽略 */ }
                }
            }
            try { fs.renameSync(basePath, `${basePath}.1`); } catch { /* 忽略 */ }
        }

        // 创建新文件流
        this._openStream();
    }

    /**
     * 输出一条日志到文件
     * @param {object} record - 日志记录
     */
    log(record) {
        if (!this._stream) {
            this._openStream();
            if (!this._stream) return;
        }

        // 格式化
        let line;
        if (this.jsonMode) {
            const jsonFormatter = require('../formatters/json');
            line = jsonFormatter.format(record);
        } else {
            const basicFormatter = require('../formatters/basic');
            line = basicFormatter.format(record);
        }

        const fullLine = line + '\n';
        const byteLength = Buffer.byteLength(fullLine);

        // 检查是否需要轮转
        if (this._currentSize + byteLength > this.maxSize) {
            this._rotate();
            // 重新打开后重试写入
            if (!this._stream) return;
        }

        this._stream.write(fullLine);
        this._currentSize += byteLength;
    }

    /** 关闭文件流 */
    close() {
        if (this._stream) {
            this._stream.end();
            this._stream = null;
        }
    }
}

module.exports = { FileTransport };