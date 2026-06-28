// ============================================================
// 难度管理器单元测试
// ============================================================
const { DifficultyManager } = require('../../src/difficulty-manager');
const { Block } = require('../../src/core');

// ============================================================
// 辅助：创建一个带有指定时间戳区间的链
// chain[0] 为创世块，从 chain[1] 开始每个块间隔 blockInterval 秒
// ============================================================
function createTimeChain(length, blockInterval = 10, startTime = '2025-01-01T00:00:00.000Z') {
    const chain = [];
    const genesis = new Block(0, startTime, '0'.repeat(64));
    genesis.hash = genesis.calculateHash();
    chain.push(genesis);

    for (let i = 1; i < length; i++) {
        const prevTime = new Date(chain[i - 1].timestamp);
        const newTime = new Date(prevTime.getTime() + blockInterval * 1000);
        const block = new Block(i, newTime.toISOString(), [], chain[i - 1].hash);
        block.hash = block.calculateHash();
        chain.push(block);
    }
    return chain;
}

// ============================================================
// 第1组: 构造器与基础功能
// ============================================================
describe('构造器与基础功能', () => {
    it('使用默认参数构造', () => {
        const dm = new DifficultyManager();
        expect(dm.difficulty).toBe(5);
        expect(dm.targetBlockTime).toBe(12);
        expect(dm.difficultyAdjustInterval).toBe(6);
        expect(dm.difficultyMin).toBe(3);
        expect(dm.difficultyMax).toBe(12);
        expect(dm.difficultyStep).toBe(0.1);
        expect(dm.lastAdjustmentBlock).toBe(0);
        expect(dm.difficultyHistory).toEqual([]);
    });

    it('使用自定义参数构造', () => {
        const dm = new DifficultyManager({
            initialDifficulty: 6,
            targetBlockTime: 10,
            difficultyAdjustInterval: 10,
            difficultyMin: 1,
            difficultyMax: 20,
            difficultyStep: 0.5,
            lastAdjustmentBlock: 10,
            difficultyHistory: [{ blockIndex: 10, oldDifficulty: 5, newDifficulty: 6 }]
        });
        expect(dm.difficulty).toBe(6);
        expect(dm.targetBlockTime).toBe(10);
        expect(dm.difficultyAdjustInterval).toBe(10);
        expect(dm.difficultyMin).toBe(1);
        expect(dm.difficultyMax).toBe(20);
        expect(dm.difficultyStep).toBe(0.5);
        expect(dm.lastAdjustmentBlock).toBe(10);
        expect(dm.difficultyHistory).toHaveLength(1);
    });

    it('toJSON 序列化返回难度关键字段', () => {
        const dm = new DifficultyManager({ initialDifficulty: 5 });
        const json = dm.toJSON();
        expect(json.difficulty).toBe(5);
        expect(json.difficultyHistory).toEqual([]);
        expect(json.lastAdjustmentBlock).toBe(0);
    });

    it('fromJSON 能正确反序列化恢复状态', () => {
        const dm = new DifficultyManager();
        dm.fromJSON({
            difficulty: 7.2,
            difficultyHistory: [{ blockIndex: 12, oldDifficulty: 7, newDifficulty: 7.2 }],
            lastAdjustmentBlock: 12
        });
        expect(dm.difficulty).toBe(7.2);
        expect(dm.difficultyHistory).toHaveLength(1);
        expect(dm.lastAdjustmentBlock).toBe(12);
    });

    it('fromJSON 忽略缺失字段（保持现有值）', () => {
        const dm = new DifficultyManager({ initialDifficulty: 5 });
        dm.fromJSON({ difficulty: 6 });
        expect(dm.difficulty).toBe(6);
        expect(dm.lastAdjustmentBlock).toBe(0); // 未传入，保持不变
    });
});

// ============================================================
// 第2组: _parseDifficulty / _meetsDifficulty 静态方法
// ============================================================
describe('难度解析与验证 (_parseDifficulty / _meetsDifficulty)', () => {
    it('整数难度 5 要求 5 个前导零，无小数约束', () => {
        const result = Block._parseDifficulty(5);
        expect(result.prefixLength).toBe(5);
        expect(result.maxNextByte).toBeNull();
    });

    it('浮点难度 5.5 要求 5 个前导零 + 下一字节 ≤ 0x7f', () => {
        const result = Block._parseDifficulty(5.5);
        expect(result.prefixLength).toBe(5);
        // 0.5 * 256 = 128 → maxNextByte = 128 (不含)
        expect(result.maxNextByte).toBe(128);
    });

    it('浮点难度 3.25 要求 3 个前导零 + 下一字节 ≤ 0x3f', () => {
        const result = Block._parseDifficulty(3.25);
        expect(result.prefixLength).toBe(3);
        // 0.25 * 256 = 64 → maxNextByte = 64 (不含)
        expect(result.maxNextByte).toBe(64);
    });

    it('难度 0 不要求前导零，也不限制下一字节', () => {
        const result = Block._parseDifficulty(0);
        expect(result.prefixLength).toBe(0);
        expect(result.maxNextByte).toBeNull();
    });

    it('难度为负数时视为 0', () => {
        const result = Block._parseDifficulty(-1);
        expect(result.prefixLength).toBe(0);
    });

    it('_meetsDifficulty: 满足整数难度时返回 true', () => {
        // 以 "00000..." 开头的 hash 应满足难度 5
        const hash = '00000' + 'a'.repeat(59);
        expect(Block._meetsDifficulty(hash, 5)).toBe(true);
    });

    it('_meetsDifficulty: 不满足整数难度时返回 false', () => {
        const hash = '00001' + 'a'.repeat(59);
        expect(Block._meetsDifficulty(hash, 5)).toBe(false);
    });

    it('_meetsDifficulty: 满足浮点难度（前缀零够 + 下字节在范围内）', () => {
        // 5 个前导零, 下一字节 0x7a = 122 < 128 → 满足 5.5
        const hash = '000007a' + 'a'.repeat(57);
        expect(Block._meetsDifficulty(hash, 5.5)).toBe(true);
    });

    it('_meetsDifficulty: 前缀零够但下字节超出范围时返回 false', () => {
        // 5 个前导零, 下一字节 0x80 = 128 ≥ 128 → 不满足 5.5
        const hash = '0000080' + 'a'.repeat(57);
        expect(Block._meetsDifficulty(hash, 5.5)).toBe(false);
    });
});

// ============================================================
// 第3组: adjustDifficulty 基础逻辑
// ============================================================
describe('adjustDifficulty 基础逻辑', () => {
    it('链长度 < 2 时不调整', () => {
        const dm = new DifficultyManager();
        dm.adjustDifficulty([{ index: 0 }], 0);
        expect(dm.difficulty).toBe(5);
        expect(dm.lastAdjustmentBlock).toBe(0);
    });

    it('距离上次调整区块数 < difficultyAdjustInterval 时不调整', () => {
        const dm = new DifficultyManager({ initialDifficulty: 5, difficultyAdjustInterval: 6 });
        // 只有 3 个块，不足 6 个
        const chain = createTimeChain(4, 12); // 0..3
        dm.adjustDifficulty(chain, 3);
        expect(dm.difficulty).toBe(5);
        expect(dm.lastAdjustmentBlock).toBe(0);
    });

    it('刚好达到调整间隔时触发调整', () => {
        const dm = new DifficultyManager({
            initialDifficulty: 5,
            targetBlockTime: 12,
            difficultyAdjustInterval: 3,
            difficultyStep: 0.1
        });
        // 4 个块 (0..3)，间隔 12 秒 → ratio = 12/12 = 1.0 → 不调整
        const chain = createTimeChain(4, 12);
        dm.adjustDifficulty(chain, 3);
        // 刚刚够 3 个间隔 block (1,2,3)，count=3 ≥ 2
        expect(dm.lastAdjustmentBlock).toBe(3);
    });
});

// ============================================================
// 第4组: adjustDifficulty 难度升降
// ============================================================
describe('adjustDifficulty 难度升降', () => {
    it('出块偏快（avgTime < target * 0.85）时上调难度', () => {
        const dm = new DifficultyManager({
            initialDifficulty: 5,
            targetBlockTime: 12,
            difficultyAdjustInterval: 6,
            difficultyStep: 0.1
        });
        // 7 个块 (0..6)，间隔 5 秒 → 远快于 12 秒 → ratio = 5/12 ≈ 0.417 < 0.85 → 上调
        const chain = createTimeChain(7, 5);
        dm.adjustDifficulty(chain, 6);
        expect(dm.difficulty).toBe(5.1);
        expect(dm.lastAdjustmentBlock).toBe(6);
    });

    it('出块偏慢（avgTime > target * 1.15）时下调难度', () => {
        const dm = new DifficultyManager({
            initialDifficulty: 5,
            targetBlockTime: 12,
            difficultyAdjustInterval: 6,
            difficultyStep: 0.1
        });
        // 7 个块 (0..6)，间隔 30 秒 → 远慢于 12 秒 → ratio = 30/12 = 2.5 > 1.15 → 下调
        const chain = createTimeChain(7, 30);
        dm.adjustDifficulty(chain, 6);
        expect(dm.difficulty).toBe(4.9);
        expect(dm.lastAdjustmentBlock).toBe(6);
    });

    it('出块时间在合理范围内（0.85 ≤ ratio ≤ 1.15）时不调整', () => {
        const dm = new DifficultyManager({
            initialDifficulty: 5,
            targetBlockTime: 12,
            difficultyAdjustInterval: 6,
            difficultyStep: 0.1
        });
        // 间隔 12 秒 → ratio = 1.0 → 不调整
        const chain = createTimeChain(7, 12);
        dm.adjustDifficulty(chain, 6);
        expect(dm.difficulty).toBe(5);
    });

    it('多次连续上调难度', () => {
        const dm = new DifficultyManager({
            initialDifficulty: 5,
            targetBlockTime: 12,
            difficultyAdjustInterval: 3,
            difficultyStep: 0.1
        });
        // 第一次调整 (idx=3)
        let chain = createTimeChain(4, 5);
        dm.adjustDifficulty(chain, 3);
        expect(dm.difficulty).toBe(5.1);

        // 第二次调整 (idx=6)
        chain = createTimeChain(10, 5);
        dm.adjustDifficulty(chain, 6);
        expect(dm.difficulty).toBe(5.2);
    });

    it('多次连续下调难度', () => {
        const dm = new DifficultyManager({
            initialDifficulty: 5,
            targetBlockTime: 12,
            difficultyAdjustInterval: 3,
            difficultyStep: 0.1
        });
        // 第一次下调 (idx=3)
        let chain = createTimeChain(4, 30);
        dm.adjustDifficulty(chain, 3);
        expect(dm.difficulty).toBe(4.9);

        // 第二次下调 (idx=6)
        chain = createTimeChain(10, 30);
        dm.adjustDifficulty(chain, 6);
        expect(dm.difficulty).toBe(4.8);
    });
});

// ============================================================
// 第5组: adjustDifficulty 边界 clamp
// ============================================================
describe('难度边界 clamp', () => {
    it('难度不会低于 difficultyMin', () => {
        const dm = new DifficultyManager({
            initialDifficulty: 3.5,
            targetBlockTime: 12,
            difficultyAdjustInterval: 3,
            difficultyMin: 3,
            difficultyMax: 12,
            difficultyStep: 0.5
        });
        // 极慢出块，下调一次 3.5 - 0.5 = 3.0
        const chain = createTimeChain(4, 300);
        dm.adjustDifficulty(chain, 3);
        expect(dm.difficulty).toBe(3.0);

        // 再下调一次，应被 clamp 在 3.0
        const chain2 = createTimeChain(10, 300);
        dm.adjustDifficulty(chain2, 6);
        expect(dm.difficulty).toBe(3.0);
    });

    it('难度不会高于 difficultyMax', () => {
        const dm = new DifficultyManager({
            initialDifficulty: 11.5,
            targetBlockTime: 12,
            difficultyAdjustInterval: 3,
            difficultyMin: 3,
            difficultyMax: 12,
            difficultyStep: 0.5
        });
        // 极快出块，上调一次 11.5 + 0.5 = 12.0
        const chain = createTimeChain(4, 1);
        dm.adjustDifficulty(chain, 3);
        expect(dm.difficulty).toBe(12.0);

        // 再上调一次，应被 clamp 在 12.0
        const chain2 = createTimeChain(10, 1);
        dm.adjustDifficulty(chain2, 6);
        expect(dm.difficulty).toBe(12.0);
    });

    it('m 精度保留一位小数（Math.round * 10 / 10）', () => {
        const dm = new DifficultyManager({
            initialDifficulty: 5,
            targetBlockTime: 12,
            difficultyAdjustInterval: 3,
            difficultyStep: 0.1
        });
        // 连续上调 3 次后应为 5.3
        for (let i = 3; i <= 9; i += 3) {
            const chain = createTimeChain(i + 4, 5);
            dm.adjustDifficulty(chain, i + 3);
        }
        expect(dm.difficulty).toBe(5.3);
    });
});

// ============================================================
// 第6组: recalculateDifficulty 全链重放
// ============================================================
describe('recalculateDifficulty 全链重放', () => {
    it('空链或单区块恢复默认值', () => {
        const dm = new DifficultyManager({ initialDifficulty: 7 });
        dm.recalculateDifficulty([]);
        expect(dm.difficulty).toBe(5);
        expect(dm.lastAdjustmentBlock).toBe(0);

        dm.recalculateDifficulty([{ index: 0 }]);
        expect(dm.difficulty).toBe(5);
        expect(dm.lastAdjustmentBlock).toBe(0);
    });

    it('全链重放结果与增量调整结果一致', () => {
        // 先通过增量调整构建难度记录
        const dm1 = new DifficultyManager({
            initialDifficulty: 5,
            targetBlockTime: 12,
            difficultyAdjustInterval: 3,
            difficultyStep: 0.1
        });
        const chain = createTimeChain(10, 8); // 较快 → 上调
        for (let i = 3; i <= 9; i += 3) {
            dm1.adjustDifficulty(chain, i);
        }

        // 再从头重放
        const dm2 = new DifficultyManager({
            targetBlockTime: 12,
            difficultyAdjustInterval: 3,
            difficultyStep: 0.1
        });
        dm2.recalculateDifficulty(chain);

        expect(dm2.difficulty).toBe(dm1.difficulty);
        expect(dm2.lastAdjustmentBlock).toBe(dm1.lastAdjustmentBlock);
    });

    it('全链重放记录难度变更历史', () => {
        const dm = new DifficultyManager({
            targetBlockTime: 12,
            difficultyAdjustInterval: 3,
            difficultyStep: 0.1
        });
        // 间隔 2 秒 → 极快 → 每次调整都上调
        const chain = createTimeChain(13, 2); // 0..12, 4 个调整点 (3,6,9,12)
        dm.recalculateDifficulty(chain);

        expect(dm.difficultyHistory.length).toBeGreaterThan(0);
        // 每次调整 oldDifficulty < newDifficulty（出块快 → 上调）
        for (const h of dm.difficultyHistory) {
            expect(h.newDifficulty).toBeGreaterThan(h.oldDifficulty);
        }
    });

    it('全链重放后难度被 clamp 在 [min, max]', () => {
        const dm = new DifficultyManager({
            targetBlockTime: 12,
            difficultyAdjustInterval: 3,
            difficultyMin: 4,
            difficultyMax: 6,
            difficultyStep: 0.1
        });
        // 极快出块 → 不断上调，但被 clamp 在 6
        const chain = createTimeChain(30, 1);
        dm.recalculateDifficulty(chain);
        expect(dm.difficulty).toBeLessThanOrEqual(6);
        expect(dm.difficulty).toBeGreaterThanOrEqual(4);
    });

    it('出块时间波动时难度上下浮动', () => {
        const dm = new DifficultyManager({
            targetBlockTime: 12,
            difficultyAdjustInterval: 3,
            difficultyStep: 0.1
        });
        // 交替快慢：快调高，慢调低，最终可能回到 5 附近
        const chain = createTimeChain(16, 12); // 间隔 12 秒 → 刚好 → 不调整
        dm.recalculateDifficulty(chain);
        expect(dm.difficulty).toBe(5);
    });
});

// ============================================================
// 第7组: adjustDifficulty 异常区块时间戳过滤
// ============================================================
describe('异常区块时间戳过滤', () => {
    it('时间差为 0 或负数的区块被忽略', () => {
        const dm = new DifficultyManager({
            initialDifficulty: 5,
            targetBlockTime: 12,
            difficultyAdjustInterval: 3,
            difficultyStep: 0.1
        });
        // 构造一个时间戳乱序的链
        const chain = [
            new Block(0, '2025-01-01T00:00:00.000Z', '0'.repeat(64)),
            new Block(1, '2025-01-01T00:00:00.000Z', '0'.repeat(64)), // 与创世块相同
            new Block(2, '2025-01-01T00:00:01.000Z', '0'.repeat(64)),
            new Block(3, '2025-01-01T00:00:01.000Z', '0'.repeat(64)), // 与前一个相同
        ];
        for (let i = 0; i < chain.length; i++) {
            chain[i].hash = chain[i].calculateHash();
        }
        // 由于时间差为 0 的会被过滤，count < 2，不调整
        dm.adjustDifficulty(chain, 3);
        expect(dm.difficulty).toBe(5);
    });

    it('时间差超过 3600 秒的区块被忽略（异常大间隔）', () => {
        const dm = new DifficultyManager({
            initialDifficulty: 5,
            targetBlockTime: 12,
            difficultyAdjustInterval: 3,
            difficultyStep: 0.1
        });
        // 间隔 4000 秒 → 被过滤
        const chain = createTimeChain(4, 4000);
        dm.adjustDifficulty(chain, 3);
        // count < 2，因为只有一个有效时间差
        expect(dm.difficulty).toBe(5);
    });
});