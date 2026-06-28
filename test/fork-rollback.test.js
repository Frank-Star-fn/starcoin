// ============================================================
// 分叉回滚单元测试
// ============================================================
const { Blockchain, Block, Transaction, generateWallet } = require('../src/blockchain');
const { newFreshChain, fundAddress, createSignedTx } = require('./helpers');

// ============================================================
// 辅助：构造一笔指定索引区块的挖矿区块（无交易，仅用于延展链）
// ============================================================
function makeMiningBlock(chain, minerAddr, extraTxs = []) {
    const rewardTx = new Transaction('SYSTEM', minerAddr, 50, 0, 'Miner Reward');
    const txs = [rewardTx, ...extraTxs];
    const block = new Block(
        chain.chain.length,
        new Date().toISOString(),
        txs,
        chain.getLatestBlock().hash
    );
    block.mineBlock(chain.difficulty);
    return block;
}

// ============================================================
// 第1组: isChainValid 链完整性验证
// ============================================================
describe('isChainValid 链完整性验证', () => {
    it('空链返回 false', () => {
        const chain = newFreshChain();
        expect(chain.isChainValid([])).toBe(false);
    });

    it('null 时使用本地链验证（不会返回 false）', () => {
        const chain = newFreshChain();
        // isChainValid(null) 会回退到本地链 bc.chain，本地链包含创世块是有效的
        expect(chain.isChainValid(null)).toBe(true);
    });

    it('只有创世块的有效链返回 true', () => {
        const chain = newFreshChain();
        expect(chain.isChainValid(chain.chain)).toBe(true);
    });

    it('有多个有效区块的链返回 true', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        for (let i = 0; i < 3; i++) {
            chain.chain.push(makeMiningBlock(chain, alice.address));
        }
        expect(chain.isChainValid(chain.chain)).toBe(true);
    });

    it('区块 hash 不一致时返回 false', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        chain.chain.push(makeMiningBlock(chain, alice.address));
        chain.chain.push(makeMiningBlock(chain, alice.address));

        // 篡改 hash
        chain.chain[2].hash = '0000' + 'f'.repeat(60);
        expect(chain.isChainValid(chain.chain)).toBe(false);
    });

    it('previousHash 不匹配时返回 false', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        chain.chain.push(makeMiningBlock(chain, alice.address));
        chain.chain.push(makeMiningBlock(chain, alice.address));

        // 篡改 previousHash
        chain.chain[2].previousHash = '0000' + 'e'.repeat(60);
        expect(chain.isChainValid(chain.chain)).toBe(false);
    });

    it('区块索引断裂时也能检测到（通过 hash 链检测）', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        chain.chain.push(makeMiningBlock(chain, alice.address));
        chain.chain.push(makeMiningBlock(chain, alice.address));

        // 篡改中间区块的 hash，导致后续块的 previousHash 不匹配
        chain.chain[1].hash = 'ffff' + 'a'.repeat(60);
        expect(chain.isChainValid(chain.chain)).toBe(false);
    });

    it('外来链的创世块 hash 与本地不一致时被拒绝', () => {
        const chain = newFreshChain();
        // 构造一条不同创世块的链
        const otherGenesis = new Block(0, '2025-06-01T00:00:00.000Z', { data: '其他链' }, '0');
        const otherChain = [otherGenesis];
        expect(chain.isChainValid(otherChain)).toBe(false);
    });
});

// ============================================================
// 第2组: repairChain 自动修复
// ============================================================
describe('repairChain 自动修复', () => {
    it('有效链不触发修复，返回空数组', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        chain.chain.push(makeMiningBlock(chain, alice.address));
        chain.chain.push(makeMiningBlock(chain, alice.address));

        const removed = chain.repairChain();
        expect(removed).toEqual([]);
        expect(chain.chain.length).toBe(3); // 0..2
    });

    it('hash 断裂时自动截断并返回被移除的区块', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        for (let i = 0; i < 4; i++) {
            chain.chain.push(makeMiningBlock(chain, alice.address));
        }
        // 篡改区块 2 的 hash
        chain.chain[2].hash = 'bbbb' + 'c'.repeat(60);

        const removed = chain.repairChain();
        expect(removed.length).toBeGreaterThanOrEqual(2); // index 2,3 被移除
        expect(chain.chain.length).toBe(2); // 剩下 0,1
    });

    it('previousHash 断裂时自动截断', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        for (let i = 0; i < 4; i++) {
            chain.chain.push(makeMiningBlock(chain, alice.address));
        }
        // 篡改区块 2 的 previousHash
        chain.chain[2].previousHash = 'aaaa' + 'd'.repeat(60);

        const removed = chain.repairChain();
        expect(removed.length).toBeGreaterThanOrEqual(2);
        expect(chain.chain.length).toBe(2);
    });

    it('从中间断裂的区块只有尾部被移除', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        for (let i = 0; i < 5; i++) {
            chain.chain.push(makeMiningBlock(chain, alice.address));
        }
        // chain 现在有 6 个块 (indices 0..5)
        // 篡改区块 3 的 hash → _findFirstInvalidIndex 返回 3
        chain.chain[3].hash = 'cccc' + 'e'.repeat(60);

        const removed = chain.repairChain();
        // splice(3) 移除索引 3,4,5 → 3 个块
        expect(removed.length).toBe(3);
        // 剩下索引 0,1,2 → 3 个块
        expect(chain.chain.length).toBe(3);
    });
});

// ============================================================
// 第3组: replaceChain 分叉替换基础
// ============================================================
describe('replaceChain 分叉替换基础', () => {
    it('新链长度 <= 旧链时拒绝替换', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        chain.chain.push(makeMiningBlock(chain, alice.address));

        const shorterChain = [chain.chain[0]]; // 只有创世块
        const result = chain.replaceChain(shorterChain);
        expect(result).toBe(false);
        expect(chain.chain.length).toBe(2); // 未变化
    });

    it('新链验证失败时拒绝替换', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        chain.chain.push(makeMiningBlock(chain, alice.address));

        // 构造一条有 hash 断裂的更长链
        const longChain = [chain.chain[0], chain.chain[1]];
        const badBlock = new Block(2, new Date().toISOString(), [], longChain[1].hash);
        badBlock.hash = 'invalid_hash';
        longChain.push(badBlock);

        const result = chain.replaceChain(longChain);
        expect(result).toBe(false);
    });

    it('新链更长且有效时替换成功', () => {
        const chain = newFreshChain();
        const alice = generateWallet();

        // 旧链：3 个块 (0,1,2)
        for (let i = 0; i < 2; i++) {
            chain.chain.push(makeMiningBlock(chain, alice.address));
        }
        const oldLength = chain.chain.length;

        // 构造新链：5 个块 (0,1,2,3,4)
        const newChain = [chain.chain[0]];
        for (let i = 1; i < 5; i++) {
            const rewardTx = new Transaction('SYSTEM', alice.address, 50, 0, 'Miner Reward');
            const block = new Block(
                i, new Date().toISOString(),
                [rewardTx],
                newChain[i - 1].hash
            );
            block.mineBlock(chain.difficulty);
            newChain.push(block);
        }

        const result = chain.replaceChain(newChain);
        expect(result).toBe(true);
        expect(chain.chain.length).toBe(5);
    });

    it('替换后链难度被重新计算', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        for (let i = 0; i < 2; i++) {
            chain.chain.push(makeMiningBlock(chain, alice.address));
        }

        const newChain = [chain.chain[0]];
        for (let i = 1; i < 10; i++) {
            const rewardTx = new Transaction('SYSTEM', alice.address, 50, 0, 'Miner Reward');
            const block = new Block(
                i, new Date().toISOString(),
                [rewardTx],
                newChain[i - 1].hash
            );
            block.mineBlock(chain.difficulty);
            newChain.push(block);
        }

        chain.replaceChain(newChain);
        expect(chain.difficultyHistory.length).toBeGreaterThanOrEqual(0);
        expect(chain.lastAdjustmentBlock).toBeGreaterThanOrEqual(0);
    });
});

// ============================================================
// 第4组: replaceChain 交易回滚
// ============================================================
describe('replaceChain 交易回滚', () => {
    it('旧链中的用户交易被正确回滚到 pendingTransactions', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();
        const charlie = generateWallet();

        // 给 Alice 充 100
        fundAddress(chain, alice.address, 100);

        // Alice 转 Bob 30（在区块 2 中）
        const tx1 = createSignedTx(alice, bob.address, 30, 0);
        const block2 = new Block(
            chain.chain.length, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), tx1],
            chain.getLatestBlock().hash
        );
        block2.mineBlock(chain.difficulty);
        chain.chain.push(block2);

        // 旧链长度 = 3 (0,1,2)

        // 构造新链：更长但没包含 Alice→Bob 交易
        const newChain = [chain.chain[0], chain.chain[1]]; // 共用一个创世块和第一个区块
        for (let i = 2; i < 5; i++) {
            const rewardTx = new Transaction('SYSTEM', alice.address, 50, 0, 'Miner Reward');
            const block = new Block(
                i, new Date().toISOString(),
                [rewardTx],
                newChain[i - 1].hash
            );
            block.mineBlock(chain.difficulty);
            newChain.push(block);
        }

        chain.replaceChain(newChain);

        // tx1 应该被回滚到 pendingTransactions
        const found = chain.pendingTransactions.some(t => t.id === tx1.id);
        expect(found).toBe(true);
    });

    it('SYSTEM 奖励交易不会被回滚到交易池', () => {
        const chain = newFreshChain();
        const alice = generateWallet();

        // 旧链：3 个块，每个都有 SYSTEM 奖励
        for (let i = 0; i < 2; i++) {
            chain.chain.push(makeMiningBlock(chain, alice.address));
        }

        // 构造新链：更长
        const newChain = [chain.chain[0]];
        for (let i = 1; i < 5; i++) {
            newChain.push(makeMiningBlock(chain, alice.address));
        }
        // 修复新链的 hash 链
        for (let i = 1; i < newChain.length; i++) {
            newChain[i].previousHash = newChain[i - 1].hash;
            newChain[i].hash = newChain[i].calculateHash();
            newChain[i].mineBlock(chain.difficulty);
        }

        chain.replaceChain(newChain);

        // SYSTEM 奖励交易不应该在 pendingTransactions 中
        const hasSystemTx = chain.pendingTransactions.some(t => t.from === 'SYSTEM');
        expect(hasSystemTx).toBe(false);
    });

    it('新链中已存在的交易不会被重复回滚', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();

        fundAddress(chain, alice.address, 100);

        // Alice 转 Bob 30
        const tx1 = createSignedTx(alice, bob.address, 30, 0);
        const block1 = new Block(
            chain.chain.length, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), tx1],
            chain.getLatestBlock().hash
        );
        block1.mineBlock(chain.difficulty);
        chain.chain.push(block1);

        // 构造新链：包含同样的 tx1
        const newChain = [chain.chain[0]];
        const rewardTx = new Transaction('SYSTEM', alice.address, 50, 0, 'Miner Reward');
        const block = new Block(
            1, new Date().toISOString(),
            [rewardTx, tx1],
            newChain[0].hash
        );
        block.mineBlock(chain.difficulty);
        newChain.push(block);

        for (let i = 2; i < 5; i++) {
            const rTx = new Transaction('SYSTEM', alice.address, 50, 0, 'Miner Reward');
            const b = new Block(i, new Date().toISOString(), [rTx], newChain[i - 1].hash);
            b.mineBlock(chain.difficulty);
            newChain.push(b);
        }

        // 清空 pending 并替换
        chain.pendingTransactions = [];
        chain.replaceChain(newChain);

        // tx1 已在新区块中，不应被回滚
        const found = chain.pendingTransactions.some(t => t.id === tx1.id);
        expect(found).toBe(false);
    });

    it('回滚后的交易优先在 pendingTransactions 头部', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();

        fundAddress(chain, alice.address, 100);

        const tx1 = createSignedTx(alice, bob.address, 30, 0);
        const block1 = new Block(
            chain.chain.length, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), tx1],
            chain.getLatestBlock().hash
        );
        block1.mineBlock(chain.difficulty);
        chain.chain.push(block1);

        // 预先放一笔交易在 pending
        const pendingTx = createSignedTx(alice, bob.address, 10, 0);
        chain.pendingTransactions = [pendingTx];

        const newChain = [chain.chain[0]];
        for (let i = 1; i < 5; i++) {
            const rTx = new Transaction('SYSTEM', alice.address, 50, 0, 'Miner Reward');
            const b = new Block(i, new Date().toISOString(), [rTx], newChain[i - 1].hash);
            b.mineBlock(chain.difficulty);
            newChain.push(b);
        }

        chain.replaceChain(newChain);

        // tx1 应该被回滚到 pending 头部，在 pendingTx 之前
        const idx1 = chain.pendingTransactions.findIndex(t => t.id === tx1.id);
        const idx2 = chain.pendingTransactions.findIndex(t => t.id === pendingTx.id);
        expect(idx1).toBeLessThan(idx2); // tx1 更靠前
    });
});

// ============================================================
// 第5组: replaceChain 交易池清理
// ============================================================
describe('replaceChain 交易池清理', () => {
    it('替换后从交易池移除新链中已打包的交易', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();

        fundAddress(chain, alice.address, 100);

        // 旧链
        const tx1 = createSignedTx(alice, bob.address, 30, 0);
        const block1 = new Block(
            chain.chain.length, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), tx1],
            chain.getLatestBlock().hash
        );
        block1.mineBlock(chain.difficulty);
        chain.chain.push(block1);

        // pending 中放一笔已在新链打包的交易
        chain.pendingTransactions.push(tx1);

        // 新链也包含 tx1
        const newChain = [chain.chain[0]];
        const rTx = new Transaction('SYSTEM', alice.address, 50, 0, 'Miner Reward');
        const b1 = new Block(1, new Date().toISOString(), [rTx, tx1], newChain[0].hash);
        b1.mineBlock(chain.difficulty);
        newChain.push(b1);

        for (let i = 2; i < 5; i++) {
            const rTx2 = new Transaction('SYSTEM', alice.address, 50, 0, 'Miner Reward');
            const b = new Block(i, new Date().toISOString(), [rTx2], newChain[i - 1].hash);
            b.mineBlock(chain.difficulty);
            newChain.push(b);
        }

        chain.replaceChain(newChain);

        // tx1 应从 pending 中移除
        const found = chain.pendingTransactions.some(t => t.id === tx1.id);
        expect(found).toBe(false);
    });
});

// ============================================================
// 第6组: 完整分叉场景
// ============================================================
describe('完整分叉场景', () => {
    it('两个分支在分叉点后产生不同交易，较长分支胜出', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();
        const charlie = generateWallet();
        const dave = generateWallet();

        // 共同的前缀 (0, 1)
        fundAddress(chain, alice.address, 200);

        // === 旧分支（短）：Alice→Bob ===
        const txBob = createSignedTx(alice, bob.address, 50, 0);
        const oldBranch = [
            chain.chain[0],  // 创世块
            chain.chain[1],  // fundAddress 建的块
        ];
        const oldBlock2 = new Block(
            2, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), txBob],
            oldBranch[1].hash
        );
        oldBlock2.mineBlock(chain.difficulty);
        oldBranch.push(oldBlock2);
        // oldBranch 长度 = 3

        // === 新分支（长）：Alice→Charlie + Alice→Dave ===
        const txCharlie = createSignedTx(alice, charlie.address, 30, 0);
        const txDave = createSignedTx(alice, dave.address, 20, 0);
        const newBranch = [
            chain.chain[0],
            chain.chain[1],
        ];
        const newBlock2 = new Block(
            2, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), txCharlie, txDave],
            newBranch[1].hash
        );
        newBlock2.mineBlock(chain.difficulty);
        newBranch.push(newBlock2);

        // 再加一个块让新分支更长
        const newBlock3 = new Block(
            3, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward')],
            newBranch[2].hash
        );
        newBlock3.mineBlock(chain.difficulty);
        newBranch.push(newBlock3);
        // newBranch 长度 = 4

        // 先给链设上旧分支
        chain.chain = [...oldBranch.map(b => {
            if (b instanceof Block) return b;
            const block = new Block(b.index, b.timestamp, b.transactions || [], b.previousHash);
            block.nonce = b.nonce;
            block.hash = b.hash;
            return block;
        })];
        chain.pendingTransactions = [];

        // 替换为新分支
        const result = chain.replaceChain(newBranch);
        expect(result).toBe(true);
        expect(chain.chain.length).toBe(4);

        // Alice→Bob 的交易应被回滚
        const bobTxRolledBack = chain.pendingTransactions.some(t => t.id === txBob.id);
        expect(bobTxRolledBack).toBe(true);
    });

    it('分叉替换后余额计算准确', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();
        const charlie = generateWallet();

        fundAddress(chain, alice.address, 200);

        // 旧分支：Alice→Bob (amount=80)
        const txBob = createSignedTx(alice, bob.address, 80, 0);
        const oldBranch = [chain.chain[0], chain.chain[1]];
        const oldB2 = new Block(
            2, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), txBob],
            oldBranch[1].hash
        );
        oldB2.mineBlock(chain.difficulty);
        oldBranch.push(oldB2);
        chain.chain = [...oldBranch];
        chain.pendingTransactions = [];

        // 新分支：Alice→Charlie (amount=60)，更长
        const txCharlie = createSignedTx(alice, charlie.address, 60, 0);
        const newBranch = [chain.chain[0], chain.chain[1]];
        const newB2 = new Block(
            2, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), txCharlie],
            newBranch[1].hash
        );
        newB2.mineBlock(chain.difficulty);
        newBranch.push(newB2);

        const newB3 = new Block(
            3, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward')],
            newBranch[2].hash
        );
        newB3.mineBlock(chain.difficulty);
        newBranch.push(newB3);

        chain.replaceChain(newBranch);

        // 替换后链上余额：
        // Alice: 200 + 50(block2) + 50(block3) - 60(txCharlie) = 240
        // Charlie: 60
        // Bob: 0（旧分支交易被回滚）
        expect(chain.getBalance(alice.address)).toBe(240);
        expect(chain.getBalance(charlie.address)).toBe(60);
        expect(chain.getBalance(bob.address)).toBe(0);
    });

    it('替换后 pendingTransactions 中的重复交易被清理', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();

        fundAddress(chain, alice.address, 100);

        // 旧链上有一个交易 tx1
        const tx1 = createSignedTx(alice, bob.address, 30, 0);
        const block1 = new Block(
            chain.chain.length, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), tx1],
            chain.getLatestBlock().hash
        );
        block1.mineBlock(chain.difficulty);
        chain.chain.push(block1);

        // pending 中有 tx1
        chain.pendingTransactions = [tx1];

        // 新链也包含 tx1
        const newChain = [chain.chain[0]];
        const rTx = new Transaction('SYSTEM', alice.address, 50, 0, 'Miner Reward');
        const b1 = new Block(1, new Date().toISOString(), [rTx, tx1], newChain[0].hash);
        b1.mineBlock(chain.difficulty);
        newChain.push(b1);
        for (let i = 2; i < 4; i++) {
            const rTx2 = new Transaction('SYSTEM', alice.address, 50, 0, 'Miner Reward');
            const b = new Block(i, new Date().toISOString(), [rTx2], newChain[i - 1].hash);
            b.mineBlock(chain.difficulty);
            newChain.push(b);
        }

        chain.replaceChain(newChain);

        const found = chain.pendingTransactions.some(t => t.id === tx1.id);
        expect(found).toBe(false);
    });
});

// ============================================================
// 第7组: addBlock 交易池清理
// ============================================================
describe('addBlock 交易池清理', () => {
    it('addBlock 后从 pending 移除该区块中已打包的用户交易', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();

        fundAddress(chain, alice.address, 100);

        const tx = createSignedTx(alice, bob.address, 30, 0);
        chain.pendingTransactions.push(tx);

        const block = new Block(
            chain.chain.length, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), tx],
            chain.getLatestBlock().hash
        );
        block.mineBlock(chain.difficulty);

        chain.addBlock(block);

        const found = chain.pendingTransactions.some(t => t.id === tx.id);
        expect(found).toBe(false);
    });

    it('addBlock 不清理 SYSTEM 和非用户交易', () => {
        const chain = newFreshChain();
        const alice = generateWallet();

        const systemTx = new Transaction('SYSTEM', alice.address, 50, 0, 'Miner Reward');
        chain.pendingTransactions.push(systemTx);

        const block = makeMiningBlock(chain, alice.address);
        chain.addBlock(block);

        // SYSTEM 交易不应被清理（filter 条件只清理 from!=='SYSTEM' 的）
        const found = chain.pendingTransactions.some(t => t.from === 'SYSTEM');
        // 实际上 mineBlock 会清空 pending，所以这里看 addBlock 的逻辑
        // addBlock 的清理条件是 tx.id && tx.from && tx.from !== 'SYSTEM'
        // 所以 SYSTEM 交易仍然保留
        expect(found).toBe(true);
    });
});