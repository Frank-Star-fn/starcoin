/**
 * 难度管理器：基于链上区块时间戳动态调整挖矿难度，确保全网共识
 * 支持单调的小数难度，完整整数目标由 protocol.js 计算。
 */
const config = require('./config');
const logger = require('./logger');

class DifficultyManager {
    /**
     * @param {Object} options
     * @param {number} [options.initialDifficulty] 初始难度（默认取自 config.js）
     * @param {number} [options.targetBlockTime]   目标出块时间（秒，默认取自 config.js）
     * @param {number} [options.difficultyAdjustInterval] 每 N 个区块调整一次（默认取自 config.js）
     * @param {number} [options.difficultyMin]     最小难度（默认取自 config.js）
     * @param {number} [options.difficultyMax]     最大难度（默认取自 config.js）
     * @param {number} [options.difficultyStep]    调整步长（默认取自 config.js）
     * @param {number} [options.lastAdjustmentBlock] 上次调整时的区块高度
     * @param {Array}  [options.difficultyHistory]     难度变更历史
     */
    constructor(options = {}) {
        this.initialDifficulty = options.initialDifficulty ?? config.DIFFICULTY_INITIAL;
        this.difficulty = options.initialDifficulty ?? config.DIFFICULTY_INITIAL;
        this.targetBlockTime = options.targetBlockTime ?? config.DIFFICULTY_TARGET_TIME;
        this.difficultyAdjustInterval = options.difficultyAdjustInterval ?? config.DIFFICULTY_ADJUST_INTERVAL;
        this.difficultyMin = options.difficultyMin ?? config.DIFFICULTY_MIN;
        this.difficultyMax = options.difficultyMax ?? config.DIFFICULTY_MAX;
        this.difficultyStep = options.difficultyStep ?? config.DIFFICULTY_STEP;
        this.lastAdjustmentBlock = options.lastAdjustmentBlock ?? 0;
        this.difficultyHistory = options.difficultyHistory ?? [];
        this.log = logger.module('Difficulty');
    }

    /**
     * 动态难度调整：每 N 个区块，根据链上区块时间戳调整难度
     * @param {Array}  chain       区块链数组
     * @param {number} latestIndex 当前最新区块索引
     */
    adjustDifficulty(chain, latestIndex) {
        if (latestIndex < 2) return;

        const blocksSinceLastAdjust = latestIndex - this.lastAdjustmentBlock;
        if (blocksSinceLastAdjust < this.difficultyAdjustInterval) return;

        // 使用链上区块时间戳计算最近 N 个区块的平均出块时间
        let totalTime = 0;
        let count = 0;
        const startIdx = Math.max(1, latestIndex - this.difficultyAdjustInterval + 1);
        for (let i = startIdx + 1; i <= latestIndex; i++) {
            const prevBlock = chain[i - 1];
            const currBlock = chain[i];
            const timeDiff = (new Date(currBlock.timestamp) - new Date(prevBlock.timestamp)) / 1000;
            if (timeDiff > 0 && timeDiff < 3600) {
                totalTime += timeDiff;
                count++;
            }
        }

        if (count < 2) return;

        const avgTime = totalTime / count;
        const oldDifficulty = this.difficulty;

        // 平滑浮点难度调整算法
        const ratio = avgTime / this.targetBlockTime;
        let delta = 0;
        if (ratio > 1.15) {
            delta = -this.difficultyStep;
        } else if (ratio < 0.85) {
            delta = +this.difficultyStep;
        }

        if (delta !== 0) {
            const raw = this.difficulty + delta;
            this.difficulty = Math.max(
                this.difficultyMin,
                Math.min(this.difficultyMax, Math.round(raw * 10) / 10)
            );
        }

        // 记录难度变更历史
        if (this.difficulty !== oldDifficulty) {
            this.difficultyHistory.push({
                blockIndex: latestIndex,
                oldDifficulty: oldDifficulty,
                newDifficulty: this.difficulty,
                avgTime: Math.round(avgTime * 10) / 10,
                targetTime: this.targetBlockTime,
                reason: avgTime > this.targetBlockTime * 1.3 ? '出块偏慢 ↓' : '出块偏快 ↑'
            });
            this.log.info('难度调整', {
                blockIndex: latestIndex,
                oldDifficulty,
                newDifficulty: this.difficulty,
                avgTime: Math.round(avgTime * 10) / 10,
                targetTime: this.targetBlockTime
            });
        } else {
            this.log.info('难度评估', {
                blockIndex: latestIndex,
                difficulty: this.difficulty,
                avgTime: Math.round(avgTime * 10) / 10,
                targetTime: this.targetBlockTime
            });
        }

        this.lastAdjustmentBlock = latestIndex;
    }

    /**
     * 全链重放难度计算：从头遍历整条链，在每个调整点按区块时间戳计算难度
     * 用于 P2P 链替换后保持所有节点难度一致
     * @param {Array} chain 区块链数组
     */
    recalculateDifficulty(chain) {
        this.difficulty = this.initialDifficulty;
        this.lastAdjustmentBlock = 0;
        this.difficultyHistory = [];
        for (let i = 1; i < chain.length; i++) this.adjustDifficulty(chain, i);
    }

    toJSON() {
        return {
            difficulty: this.difficulty,
            difficultyHistory: this.difficultyHistory,
            lastAdjustmentBlock: this.lastAdjustmentBlock
        };
    }

    /**
     * 反序列化恢复难度数据
     */
    fromJSON(data) {
        if (data.difficulty != null) {
            this.difficulty = data.difficulty;
        }
        if (data.difficultyHistory) {
            this.difficultyHistory = data.difficultyHistory;
        }
        if (data.lastAdjustmentBlock != null) {
            this.lastAdjustmentBlock = data.lastAdjustmentBlock;
        }
    }
}

module.exports = { DifficultyManager };
