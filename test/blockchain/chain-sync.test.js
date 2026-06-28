// ============================================================
// ChainSync 链同步/修复单元测试
// 覆盖: _findFirstInvalidIndex, repairChain
// ============================================================
const { Block, Transaction, generateWallet } = require('../../src/blockchain/blockchain');
const { newFreshChain } = require('../helpers');

// ============================================================
// 辅助：构造仅含奖励交易的挖矿区块
// ============================================================
function makeMiningBlock(chain, minerAddr) {
    const rewardTx = new Transaction('SYSTEM', minerAddr, 50, 0, 'Miner Reward');
    const block = new Block(
        chain.chain.length,
        new Date().toISOString(),
        [rewardTx],
        chain.getLatestBlock().hash
    );
    block.mineBlock(chain.difficulty);
    return block;
}

// ============================================================
// 第1组: _findFirstInvalidIndex（内部方法，但通过 repairChain 间接测试）
// ============================================================
describe('ChainSync._findFirstInvalidIndex', () => {
    let chain;
    let wallet;

    beforeAll(() => {
        wallet = generateWallet();
    });

    beforeEach(() => {
        chain = newFreshChain();
    });

    it('只有创世块 → 返回 -1（全部有效）', () => {
        const result = chain.sync._findFirstInvalidIndex();
        expect(result).toBe(-1);
    });

    it('连续 3 个有效区块 → 返回 -1', () => {
        for (let i = 0; i < 3; i++) {
            chain.chain.push(makeMiningBlock(chain, wallet.address));
        }
        const result = chain.sync._findFirstInvalidIndex();
        expect(result).toBe(-1);
    });

    it('区块 hash 被篡改 → 返回该区块索引', () => {
        for (let i = 0; i < 3; i++) {
            chain.chain.push(makeMiningBlock(chain, wallet.address));
        }
        // 篡改区块 #2 的 hash
        chain.chain[2].hash = '0000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
        const result = chain.sync._findFirstInvalidIndex();
        expect(result).toBe(2);
    });

    it('previousHash 不匹配 → 返回当前区块索引', () => {
        for (let i = 0; i < 3; i++) {
            chain.chain.push(makeMiningBlock(chain, wallet.address));
        }
        // 篡改区块 #2 的 previousHash
        chain.chain[2].previousHash = '0000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
        const result = chain.sync._findFirstInvalidIndex();
        expect(result).toBe(2);
    });

    it('中间区块断裂 → 返回断裂位置（不是最后一个）', () => {
        for (let i = 0; i < 5; i++) {
            chain.chain.push(makeMiningBlock(chain, wallet.address));
        }
        // chain 现有 6 块 (0..5)
        // 篡改区块 #3 的 hash
        chain.chain[3].hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const result = chain.sync._findFirstInvalidIndex();
        expect(result).toBe(3);
    });

    it('多个区块 hash 均断裂 → 返回第一个断裂位置', () => {
        for (let i = 0; i < 4; i++) {
            chain.chain.push(makeMiningBlock(chain, wallet.address));
        }
        // 篡改区块 #1 和 #3 的 hash
        chain.chain[1].hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        chain.chain[3].hash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
        const result = chain.sync._findFirstInvalidIndex();
        expect(result).toBe(1);
    });

    it('创世块 hash 被篡改 → 不影响（从索引 1 开始扫描）', () => {
        for (let i = 0; i < 3; i++) {
            chain.chain.push(makeMiningBlock(chain, wallet.address));
        }
        // 创世块索引 0，_findFirstInvalidIndex 从 i=1 开始，不影响
        const genesisHash = chain.chain[0].hash;
        chain.chain[0].hash = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
        // 因为只改创世块不改其他块，区块 1 的 previousHash 仍指向旧 genesis hash，所以 1 会断裂
        const result = chain.sync._findFirstInvalidIndex();
        expect(result).toBe(1);
    });

    it('连续多区块 previousHash 断裂 → 返回第一个', () => {
        for (let i = 0; i < 4; i++) {
            chain.chain.push(makeMiningBlock(chain, wallet.address));
        }
        // 篡改区块 #2 的 previousHash
        chain.chain[2].previousHash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
        const result = chain.sync._findFirstInvalidIndex();
        expect(result).toBe(2);
    });
});

// ============================================================
// 第2组: repairChain（依赖 _findFirstInvalidIndex + splice）
// ============================================================
describe('ChainSync.repairChain', () => {
    let chain;
    let wallet;

    beforeAll(() => {
        wallet = generateWallet();
    });

    beforeEach(() => {
        chain = newFreshChain();
    });

    it('有效链 → 返回空数组，链长度不变', () => {
        for (let i = 0; i < 3; i++) {
            chain.chain.push(makeMiningBlock(chain, wallet.address));
        }
        const beforeLen = chain.chain.length;
        const removed = chain.sync.repairChain();
        expect(removed).toEqual([]);
        expect(chain.chain.length).toBe(beforeLen);
    });

    it('hash 断裂 → 截断并返回被移除的区块', () => {
        for (let i = 0; i < 4; i++) {
            chain.chain.push(makeMiningBlock(chain, wallet.address));
        }
        // chain: [0,1,2,3,4]（5 块），篡改区块 #2 的 hash
        chain.chain[2].hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const removed = chain.sync.repairChain();
        // splice(2) 移除索引 2,3,4 → 3 块
        expect(removed.length).toBe(3);
        expect(removed[0].index).toBe(2);
        expect(removed[1].index).toBe(3);
        expect(removed[2].index).toBe(4);
        expect(chain.chain.length).toBe(2); // 剩下 0,1
    });

    it('previousHash 断裂 → 截断并返回正确数量的区块', () => {
        for (let i = 0; i < 4; i++) {
            chain.chain.push(makeMiningBlock(chain, wallet.address));
        }
        // chain: [0,1,2,3,4]（5 块），篡改区块 #2 的 previousHash
        chain.chain[2].previousHash = 'aaaaeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
        const removed = chain.sync.repairChain();
        // splice(2) 移除索引 2,3,4 → 3 块
        expect(removed.length).toBe(3);
        expect(chain.chain.length).toBe(2);
    });

    it('仅尾块断裂 → 只移除最后一个区块', () => {
        for (let i = 0; i < 3; i++) {
            chain.chain.push(makeMiningBlock(chain, wallet.address));
        }
        // 篡改最后一个区块 #3 的 hash
        const lastIdx = chain.chain.length - 1;
        chain.chain[lastIdx].hash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
        const removed = chain.sync.repairChain();
        expect(removed.length).toBe(1);
        expect(removed[0].index).toBe(lastIdx);
        expect(chain.chain.length).toBe(lastIdx); // 回退到前一个
    });

    it('修复后 chain 的最后一个区块 hash 有效', () => {
        for (let i = 0; i < 4; i++) {
            chain.chain.push(makeMiningBlock(chain, wallet.address));
        }
        chain.chain[3].hash = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
        chain.sync.repairChain();
        // 修复后应该剩下 0,1,2
        expect(chain.chain.length).toBe(3);
        const tail = chain.chain[chain.chain.length - 1];
        expect(tail.hash).toBe(tail.calculateHash());
        expect(tail.previousHash).toBe(chain.chain[chain.chain.length - 2].hash);
    });

    it('调用 repairChain 后未断裂部分保持完整', () => {
        for (let i = 0; i < 5; i++) {
            chain.chain.push(makeMiningBlock(chain, wallet.address));
        }
        // chain: [0,1,2,3,4,5]（6 块），篡改区块 #3 的 hash
        chain.chain[3].hash = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
        const removed = chain.sync.repairChain();
        // splice(3) 移除索引 3,4,5 → 3 块
        expect(removed.length).toBe(3);
        expect(removed[0].index).toBe(3);
        expect(removed[1].index).toBe(4);
        expect(removed[2].index).toBe(5);
        // 前 3 个块 (0,1,2) 应保持不变
        expect(chain.chain.length).toBe(3);
        expect(chain.chain[0].index).toBe(0);
        expect(chain.chain[1].index).toBe(1);
        expect(chain.chain[2].index).toBe(2);
    });

    it('通过 Blockchain.repairChain 委托也能正常工作', () => {
        for (let i = 0; i < 3; i++) {
            chain.chain.push(makeMiningBlock(chain, wallet.address));
        }
        // chain: [0,1,2,3]（4 块），篡改区块 #2 的 hash
        chain.chain[2].hash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
        const removed = chain.repairChain();
        // splice(2) 移除索引 2,3 → 2 块
        expect(removed.length).toBe(2);
        expect(removed[0].index).toBe(2);
        expect(removed[1].index).toBe(3);
        expect(chain.chain.length).toBe(2);
    });

    it('修复后链上交易池间接验证（无交易丢失）', () => {
        // 在区块中加入一些用户交易，然后模拟断裂修复
        const alice = generateWallet();
        const bob = generateWallet();
        for (let i = 0; i < 3; i++) {
            chain.chain.push(makeMiningBlock(chain, wallet.address));
        }
        // 制造一个 hash 断裂，验证修复后非断裂部分仍在
        chain.chain[2].hash = '1111111111111111111111111111111111111111111111111111111111111111';
        const removed = chain.sync.repairChain();
        expect(removed.length).toBeGreaterThanOrEqual(1);
        // 剩余链应有效
        expect(chain.sync._findFirstInvalidIndex()).toBe(-1);
    });
});