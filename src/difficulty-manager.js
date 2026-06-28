/**
 * 难度管理器：基于链上区块时间戳动态调整挖矿难度，确保全网共识
 * 支持浮点难度（如 5.5 = 5个零 + 下字节≤0x7f）
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
        if (chain.length < 2) {
            this.difficulty = 5;
            this.lastAdjustmentBlock = 0;
            this.difficultyHistory = [];
            return;
        }

        let diff = 5;
        let lastAdj = 0;
        const history = [];

        for (let i = 1; i < chain.length; i++) {
            const blocksSinceLast = i - lastAdj;
            if (blocksSinceLast >= this.difficultyAdjustInterval && i >= 2) {
                const startIdx = Math.max(1, i - this.difficultyAdjustInterval + 1);
                let totalTime = 0;
                let count = 0;
                for (let j = startIdx + 1; j <= i; j++) {
                    const prevB = chain[j - 1];
                    const currB = chain[j];
                    const timeDiff = (new Date(currB.timestamp) - new Date(prevB.timestamp)) / 1000;
                    if (timeDiff > 0 && timeDiff < 3600) {
                        totalTime += timeDiff;
                        count++;
                    }
                }

                if (count >= 2) {
                    const avgTime = totalTime / count;
                    const ratio = avgTime / this.targetBlockTime;
                    let delta = 0;
                    if (ratio > 1.15) {
                        delta = -this.difficultyStep;
                    } else if (ratio < 0.85) {
                        delta = +this.difficultyStep;
                    }
                    if (delta !== 0) {
                        const oldDiffBefore = diff;
                        const raw = diff + delta;
                        diff = Math.max(
                            this.difficultyMin,
                            Math.min(this.difficultyMax, Math.round(raw * 10) / 10)
                        );
                        history.push({
                            blockIndex: i,
                            oldDifficulty: oldDiffBefore,
                            newDifficulty: diff,
                            avgTime: Math.round(avgTime * 10) / 10,
                            targetTime: this.targetBlockTime,
                            reason: avgTime > this.targetBlockTime * 1.3 ? '出块偏慢 ↓' : '出块偏快 ↑'
                        });
                    }
                    lastAdj = i;
                }
            }
        }

        const oldDiff = this.difficulty;
        this.difficulty = diff;
        this.lastAdjustmentBlock = lastAdj;
        this.difficultyHistory = history;

        if (Math.abs(this.difficulty - oldDiff) > 0.01) {
            this.log.info('难度重新计算（全链重放）', {
                oldDifficulty: oldDiff,
                newDifficulty: this.difficulty,
                chainLength: chain.length,
                adjustmentCount: history.length
            });
        }
    }

    /**
     * 序列化难度数据（用于持久化）
     */
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