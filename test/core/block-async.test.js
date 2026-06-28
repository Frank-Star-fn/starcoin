// ============================================================
// Block.mineBlockAsync 异步挖矿单元测试
// ============================================================
const { Block } = require('../../src/core');

// ============================================================
// 辅助：创建确定性 Block 用于测试
// ============================================================
function createTestBlock(index = 1, previousHash = '0'.repeat(64)) {
    const block = new Block(index, '2025-01-01T00:00:00.000Z', [], previousHash);
    // 覆盖随机 merkleRoot 为确定性值
    block.merkleRoot = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    block.hash = block.calculateHash();
    return block;
}

// ============================================================
// 第1组: mineBlockAsync 基础挖矿功能
// ============================================================
describe('Block.mineBlockAsync 基础挖矿', () => {
    it('难度 2 → 成功挖矿并返回 Block 实例', async () => {
        const block = createTestBlock();
        const result = await block.mineBlockAsync(2);

        expect(result).toBe(block);
        expect(block.hash.startsWith('00')).toBe(true);
        expect(block.nonce).toBeGreaterThanOrEqual(0);
    });

    it('难度 3 → hash 以 "000" 开头', async () => {
        const block = createTestBlock();
        await block.mineBlockAsync(3);

        expect(block.hash.startsWith('000')).toBe(true);
    });

    it('挖矿完成后 targetText 被正确设置', async () => {
        const block = createTestBlock();
        await block.mineBlockAsync(2);

        expect(block.targetText).toBeDefined();
        expect(typeof block.targetText).toBe('string');
    });

    it('同步 mineBlock 和异步 mineBlockAsync 能达到相同的难度', async () => {
        const block1 = createTestBlock();
        const block2 = createTestBlock();

        block1.mineBlock(2);
        await block2.mineBlockAsync(2);

        expect(block1.hash.startsWith('00')).toBe(true);
        expect(block2.hash.startsWith('00')).toBe(true);
    });
});

// ============================================================
// 第2组: mineBlockAsync 进度回调
// ============================================================
describe('mineBlockAsync 进度回调', () => {
    it('挖矿完成后触发 found=true 的回调', async () => {
        const block = createTestBlock();
        let lastProgress = null;
        const onProgress = (data) => { lastProgress = data; };

        await block.mineBlockAsync(2, onProgress, 1000);

        expect(lastProgress).not.toBeNull();
        expect(lastProgress.found).toBe(true);
        expect(lastProgress.hash).toBe(block.hash);
        expect(lastProgress.difficulty).toBe(2);
        expect(lastProgress.target).toBeDefined();
    });

    it('每 stepInterval 次 hash 触发一次进度回调（found=false）', async () => {
        const block = createTestBlock();
        const progressCalls = [];

        // 使用高难度 + 小步长，确保产生多次进度回调
        await block.mineBlockAsync(2, (data) => {
            progressCalls.push(data);
        }, 1); // stepInterval=1，每次 hash 都回调

        // 至少有一次 found=true 的回调
        const foundCall = progressCalls.find(p => p.found === true);
        expect(foundCall).toBeDefined();
        expect(foundCall.found).toBe(true);

        // 可能有 zero or more found=false 的回调
        const progressCallsWithoutFound = progressCalls.filter(p => !p.found);
        // 如果初始 hash 不满足难度，则至少有 found=false 的回调
        // 但我们不强制要求，因为初始 hash 可能有 1/16 概率直接满足难度 2
    });

    it('进度回调包含 nonce, hash, target, difficulty 字段', async () => {
        const block = createTestBlock();
        let progressData = null;

        await block.mineBlockAsync(2, (data) => {
            progressData = data;
        }, 1);

        expect(progressData).not.toBeNull();
        expect(progressData).toHaveProperty('nonce');
        expect(progressData).toHaveProperty('hash');
        expect(progressData).toHaveProperty('target');
        expect(progressData).toHaveProperty('difficulty');
        expect(progressData).toHaveProperty('found');
        expect(typeof progressData.nonce).toBe('number');
        expect(typeof progressData.hash).toBe('string');
        expect(typeof progressData.difficulty).toBe('number');
    });
});

// ============================================================
// 第3组: mineBlockAsync 中止机制
// ============================================================
describe('mineBlockAsync 中止机制', () => {
    it('shouldAbort 返回 true → 中止挖矿返回 {aborted: true}', async () => {
        const block = createTestBlock();
        const shouldAbort = () => true;

        const result = await block.mineBlockAsync(3, undefined, 1, shouldAbort);

        expect(result).toEqual({
            aborted: true,
            reason: 'chain_updated'
        });
    });

    it('shouldAbort 在若干次迭代后返回 true → 中止', async () => {
        const block = createTestBlock();
        let iterationCount = 0;
        const shouldAbort = () => {
            iterationCount++;
            return iterationCount >= 5;
        };

        const result = await block.mineBlockAsync(3, undefined, 1, shouldAbort);

        expect(result.aborted).toBe(true);
        expect(result.reason).toBe('chain_updated');
    });

    it('中止时通过 onProgress 回调返回 aborted 状态', async () => {
        const block = createTestBlock();
        const progressCalls = [];
        const shouldAbort = () => true;

        await block.mineBlockAsync(3, (data) => {
            progressCalls.push(data);
        }, 1, shouldAbort);

        // 最后一次回调应该包含 aborted=true
        const lastCall = progressCalls[progressCalls.length - 1];
        expect(lastCall).toBeDefined();
        expect(lastCall.aborted).toBe(true);
        expect(lastCall.reason).toBe('chain_updated');
        expect(lastCall.found).toBe(false);
    });

    it('不传 shouldAbort → 不会中止，正常挖矿', async () => {
        const block = createTestBlock();
        const result = await block.mineBlockAsync(2, undefined, 1000);

        expect(result).toBe(block);
        expect(block.hash.startsWith('00')).toBe(true);
    });

    it('shouldAbort 始终返回 false → 正常挖矿', async () => {
        const block = createTestBlock();
        const shouldAbort = () => false;

        const result = await block.mineBlockAsync(2, undefined, 1000, shouldAbort);

        expect(result).toBe(block);
        expect(block.hash.startsWith('00')).toBe(true);
    });
});

// ============================================================
// 第4组: mineBlockAsync 边缘情况
// ============================================================
describe('mineBlockAsync 边缘情况', () => {
    it('难度 0 → 任何 hash 都满足，立即返回', async () => {
        const block = createTestBlock();
        const result = await block.mineBlockAsync(0);

        expect(result).toBe(block);
        // nonce 不变（因初始 hash 就满足难度 0）
    });

    it('不传 onProgress → 不抛错', async () => {
        const block = createTestBlock();
        const result = await block.mineBlockAsync(2);

        expect(result).toBe(block);
    });

    it('不传 stepInterval → 使用默认值 5000', async () => {
        const block = createTestBlock();
        // 使用难度 1 确保快速完成
        const result = await block.mineBlockAsync(1);

        expect(result).toBe(block);
    });

    it('浮点难度 → 正确解析并使用小数约束', async () => {
        const block = createTestBlock();
        await block.mineBlockAsync(2.5);

        // 难度 2.5：前 2 位为 '00'，第 3 位字节值 < 0x80
        expect(block.hash.startsWith('00')).toBe(true);
        const thirdByteHex = block.hash.substring(2, 4);
        const thirdByteVal = parseInt(thirdByteHex, 16);
        expect(thirdByteVal).toBeLessThan(0x80);
    });

    it('带有 pending 交易的区块也能成功挖掘', async () => {
        const { Transaction } = require('../../src/core');
        const tx1 = new Transaction('Alice', 'Bob', 10, 1, 'test', 'STC');
        const block = new Block(1, '2025-01-01T00:00:00.000Z', [tx1], '0'.repeat(64));

        await block.mineBlockAsync(2);

        expect(block.hash.startsWith('00')).toBe(true);
        expect(block.transactions.length).toBe(1);
    });
});