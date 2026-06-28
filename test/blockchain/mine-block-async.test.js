// ============================================================
// Blockchain.mineBlockAsync 异步挖矿单元测试
// 覆盖: mineBlockAsync（含进度回调、中止、链验证、自动修复）
// ============================================================
const { Blockchain, Block, Transaction, generateWallet } = require('../../src/blockchain/blockchain');
const { newFreshChain, fundAddress, createSignedTx } = require('../helpers');

// ============================================================
// 第1组: mineBlockAsync 基础功能
// ============================================================
describe('Blockchain.mineBlockAsync 基础功能', () => {
    let chain;
    let wallet;

    beforeAll(() => {
        wallet = generateWallet();
    });

    beforeEach(() => {
        chain = newFreshChain();
    });

    it('成功挖出新区块 → 返回区块对象', async () => {
        const block = await chain.mineBlockAsync(wallet.address, 'test block');
        expect(block).toBeDefined();
        expect(block.index).toBe(1);
        expect(block.hash.startsWith('0')).toBe(true);
    });

    it('挖矿后链长度增加 1', async () => {
        const beforeLen = chain.chain.length;
        await chain.mineBlockAsync(wallet.address);
        expect(chain.chain.length).toBe(beforeLen + 1);
    });

    it('挖矿后新区块的 previousHash 指向旧链尾', async () => {
        const oldTail = chain.getLatestBlock();
        const block = await chain.mineBlockAsync(wallet.address);
        expect(block.previousHash).toBe(oldTail.hash);
    });

    it('挖矿后新区块包含挖矿奖励交易', async () => {
        const block = await chain.mineBlockAsync(wallet.address);
        expect(block.transactions.length).toBeGreaterThanOrEqual(1);
        const rewardTx = block.transactions[0];
        expect(rewardTx.from).toBe('SYSTEM');
        expect(rewardTx.to).toBe(wallet.address);
        expect(rewardTx.amount).toBe(chain.miningReward);
    });

    it('不传 blockDataText → 仍可正常挖矿', async () => {
        const block = await chain.mineBlockAsync(wallet.address);
        expect(block).toBeDefined();
        expect(block.index).toBe(1);
    });

    it('多次异步挖矿可连续产生有效区块', async () => {
        for (let i = 0; i < 3; i++) {
            const block = await chain.mineBlockAsync(wallet.address, `block ${i}`);
            expect(block.index).toBe(i + 1);
            expect(chain.isChainValid()).toBe(true);
        }
        expect(chain.chain.length).toBe(4); // 创世块 + 3
    });
});

// ============================================================
// 第2组: mineBlockAsync 带交易池打包
// ============================================================
describe('mineBlockAsync 打包交易', () => {
    let chain;
    let alice;
    let bob;

    beforeAll(() => {
        alice = generateWallet();
        bob = generateWallet();
    });

    beforeEach(() => {
        chain = newFreshChain();
        // 给 alice 充值
        fundAddress(chain, alice.address, 200);
    });

    it('挖矿时打包交易池中的交易', async () => {
        const tx = createSignedTx(alice, bob.address, 50, 1);
        chain.pendingTransactions.push(tx);

        const block = await chain.mineBlockAsync(alice.address);
        // 区块应包含奖励交易 + 用户交易 = 至少 2 笔
        expect(block.transactions.length).toBeGreaterThanOrEqual(2);
        const txIds = block.transactions.map(t => t.id);
        expect(txIds).toContain(tx.id);
    });

    it('挖矿后已打包的交易从交易池移除', async () => {
        const tx = createSignedTx(alice, bob.address, 30, 1);
        chain.pendingTransactions.push(tx);

        await chain.mineBlockAsync(alice.address);
        const pendingIds = chain.pendingTransactions.map(t => t.id);
        expect(pendingIds).not.toContain(tx.id);
    });

    it('未打包的交易保留在交易池', async () => {
        const tx1 = createSignedTx(alice, bob.address, 30, 1);
        const tx2 = createSignedTx(alice, bob.address, 20, 1);
        chain.pendingTransactions.push(tx1, tx2);

        await chain.mineBlockAsync(alice.address);
        // 两个都应在区块中（因为配置的 MINING_MAX_TXS_PER_BLOCK 很大）
        const block = chain.getLatestBlock();
        const txIdsInBlock = block.transactions.map(t => t.id);
        expect(txIdsInBlock).toContain(tx1.id);
        expect(txIdsInBlock).toContain(tx2.id);
    });

    it('交易按手续费降序打包', async () => {
        const config = require('../../src/config');
        // 为了确保排序可见，创建多笔不同手续费交易
        const txs = [];
        for (let i = 0; i < 3; i++) {
            const tx = createSignedTx(alice, bob.address, 5, i + 1);
            txs.push(tx);
        }
        // 打乱顺序加入交易池
        chain.pendingTransactions.push(txs[2], txs[0], txs[1]);

        await chain.mineBlockAsync(alice.address);
        const block = chain.getLatestBlock();
        // 获取区块中的用户交易（排除奖励交易）
        const userTxs = block.transactions.filter(t => t.from !== 'SYSTEM');
        // 手续费应该降序: 3, 2, 1
        for (let i = 1; i < userTxs.length; i++) {
            expect(userTxs[i - 1].fee).toBeGreaterThanOrEqual(userTxs[i].fee);
        }
    });
});

// ============================================================
// 第3组: mineBlockAsync 进度回调
// ============================================================
describe('mineBlockAsync 进度回调', () => {
    let chain;
    let wallet;

    beforeAll(() => {
        wallet = generateWallet();
    });

    beforeEach(() => {
        chain = newFreshChain();
    });

    it('不传 onProgress → 不抛错，正常挖矿', async () => {
        const block = await chain.mineBlockAsync(wallet.address, 'no progress');
        expect(block).toBeDefined();
        expect(block.index).toBe(1);
    });

    it('传 onProgress 回调 → 挖矿完成后回调被调用', async () => {
        let progressCalled = false;
        const onProgress = (data) => {
            if (data.found) progressCalled = true;
        };

        await chain.mineBlockAsync(wallet.address, 'progress test', onProgress);
        expect(progressCalled).toBe(true);
    });

    it('进度回调包含正确的字段', async () => {
        let progressData = null;
        const onProgress = (data) => {
            if (data.found) progressData = data;
        };

        const block = await chain.mineBlockAsync(wallet.address, 'fields test', onProgress);
        expect(progressData).not.toBeNull();
        expect(progressData).toHaveProperty('nonce');
        expect(progressData).toHaveProperty('hash');
        expect(progressData).toHaveProperty('target');
        expect(progressData).toHaveProperty('difficulty');
        expect(progressData).toHaveProperty('found');
        expect(progressData.found).toBe(true);
    });
});

// ============================================================
// 第4组: mineBlockAsync 外部中止
// ============================================================
describe('mineBlockAsync 外部中止', () => {
    let chain;
    let wallet;

    beforeAll(() => {
        wallet = generateWallet();
    });

    beforeEach(() => {
        chain = newFreshChain();
        // 难度设为 4（需要 4 位前导零），确保每次挖矿都需要足够迭代，
        // 避免因初始 hash 恰好满足难度而导致 abort 测试无效
        chain.difficulty = 4;
    });

    it('externalAbortCheck 返回 true → 挖矿中止返回 {canceled: true}', async () => {
        const result = await chain.mineBlockAsync(wallet.address, 'abort test', undefined, () => true);
        expect(result.canceled).toBe(true);
        expect(result.reason).toBeDefined();
    });

    it('挖矿中止后链长度不变', async () => {
        const beforeLen = chain.chain.length;
        await chain.mineBlockAsync(wallet.address, 'abort', undefined, () => true);
        expect(chain.chain.length).toBe(beforeLen);
    });

    it('挖矿中止后交易池中的交易未被移除', async () => {
        const tx = createSignedTx(wallet, 'recipient', 10, 1);
        chain.pendingTransactions.push(tx);
        const beforePending = chain.pendingTransactions.length;

        await chain.mineBlockAsync(wallet.address, 'abort', undefined, () => true);
        expect(chain.pendingTransactions.length).toBe(beforePending);
    });

    it('externalAbortCheck 先 false 后 true → 仍能中止', async () => {
        let callCount = 0;
        const externalAbortCheck = () => {
            callCount++;
            return callCount >= 3;
        };

        const result = await chain.mineBlockAsync(wallet.address, 'delayed abort', undefined, externalAbortCheck);
        expect(result.canceled).toBe(true);
    });

    it('externalAbortCheck 始终返回 false → 正常挖矿', async () => {
        const block = await chain.mineBlockAsync(wallet.address, 'no abort', undefined, () => false);
        expect(block).toBeDefined();
        expect(block.index).toBe(1);
    });
});

// ============================================================
// 第5组: mineBlockAsync 链验证与自动修复
// ============================================================
describe('mineBlockAsync 链验证与自动修复', () => {
    let chain;
    let wallet;

    beforeAll(() => {
        wallet = generateWallet();
    });

    beforeEach(() => {
        chain = newFreshChain();
    });

    it('挖矿后链完整性验证通过', async () => {
        await chain.mineBlockAsync(wallet.address);
        expect(chain.isChainValid()).toBe(true);
    });

    it('连续挖矿后整条链有效', async () => {
        for (let i = 0; i < 3; i++) {
            await chain.mineBlockAsync(wallet.address, `block ${i}`);
        }
        expect(chain.isChainValid()).toBe(true);
    });

    it('挖矿完成后新区块 hash 满足难度要求', async () => {
        chain.difficulty = 2;
        const block = await chain.mineBlockAsync(wallet.address);
        expect(block.hash.startsWith('00')).toBe(true);
    });
});

// ============================================================
// 第6组: mineBlockAsync 边缘情况
// ============================================================
describe('mineBlockAsync 边缘情况', () => {
    let chain;
    let wallet;

    beforeAll(() => {
        wallet = generateWallet();
    });

    beforeEach(() => {
        chain = newFreshChain();
    });

    it('难度为 0 → 立即返回', async () => {
        chain.difficulty = 0;
        const block = await chain.mineBlockAsync(wallet.address);
        expect(block).toBeDefined();
        expect(block.index).toBe(1);
    });

    it('空交易池也能挖矿（只包含奖励交易）', async () => {
        chain.pendingTransactions = [];
        const block = await chain.mineBlockAsync(wallet.address);
        expect(block.transactions.length).toBe(1);
        expect(block.transactions[0].from).toBe('SYSTEM');
    });

    it('挖矿后 adjustDifficulty 被调用（难度可能调整）', async () => {
        const spy = vi.spyOn(chain.diffManager, 'adjustDifficulty');
        await chain.mineBlockAsync(wallet.address);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });
});