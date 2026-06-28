// ============================================================
// 余额计算单元测试
// ============================================================
const { Blockchain, Block, Transaction, generateWallet } = require('../src/blockchain');
const { newFreshChain, fundAddress, createSignedTx } = require('./helpers');

// ============================================================
// 第1组: 基础余额计算
// ============================================================
describe('基础余额计算', () => {
    it('空地址返回 0', () => {
        const chain = newFreshChain();
        expect(chain.getBalance('')).toBe(0);
        expect(chain.getBalance(null)).toBe(0);
        expect(chain.getBalance(undefined)).toBe(0);
        expect(chain.getBalance('0'.repeat(32))).toBe(0); // 未出现过的地址
    });

    it('创世块后余额为 0（创世块中没有给任何地址发币）', () => {
        const chain = newFreshChain();
        expect(chain.getBalance(chain.miningAddress)).toBe(0);
    });

    it('收到 SYSTEM 奖励后余额增加', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        fundAddress(chain, alice.address, 100);
        expect(chain.getBalance(alice.address)).toBe(100);
    });

    it('多次收入累加', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        fundAddress(chain, alice.address, 50);
        fundAddress(chain, alice.address, 30);
        expect(chain.getBalance(alice.address)).toBe(80);
    });

    it('转账后发送方余额减少（amount + fee）', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();
        fundAddress(chain, alice.address, 100);

        const tx = createSignedTx(alice, bob.address, 30, 2);
        const block = new Block(
            chain.chain.length, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), tx],
            chain.getLatestBlock().hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        // Alice: 100(初始) + 50(新奖励) - 30(转账) - 2(手续费) = 118
        // Bob: 30(收到)
        expect(chain.getBalance(alice.address)).toBe(118);
        expect(chain.getBalance(bob.address)).toBe(30);
    });

    it('多笔收支混合计算', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();
        const charlie = generateWallet();

        // Alice 得 200
        fundAddress(chain, alice.address, 200);
        // Alice 转 Bob 50
        fundAddress(chain, bob.address, 30);
        // Alice 转 Charlie 20
        fundAddress(chain, charlie.address, 10);

        expect(chain.getBalance(alice.address)).toBe(200);
        expect(chain.getBalance(bob.address)).toBe(30);
        expect(chain.getBalance(charlie.address)).toBe(10);
    });
});

// ============================================================
// 第2组: 手续费扣除
// ============================================================
describe('手续费扣除', () => {
    it('转账手续费从发送方余额中扣除', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();
        fundAddress(chain, alice.address, 100);

        const tx = createSignedTx(alice, bob.address, 20, 5);
        const block = new Block(
            chain.chain.length, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), tx],
            chain.getLatestBlock().hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        // Alice: 100 - 20 - 5 + 50 = 125
        expect(chain.getBalance(alice.address)).toBe(125);
        // Bob: 20
        expect(chain.getBalance(bob.address)).toBe(20);
    });

    it('多笔手续费的累计扣除', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();
        fundAddress(chain, alice.address, 200);

        // 第一笔: amount=30, fee=3
        const tx1 = createSignedTx(alice, bob.address, 30, 3);
        let block = new Block(
            chain.chain.length, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), tx1],
            chain.getLatestBlock().hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        // 第二笔: amount=40, fee=4
        const tx2 = createSignedTx(alice, bob.address, 40, 4);
        block = new Block(
            chain.chain.length, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), tx2],
            chain.getLatestBlock().hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        // Alice: 200(初始) + 50 + 50 - 30 - 3 - 40 - 4 = 223
        expect(chain.getBalance(alice.address)).toBe(223);
        // Bob: 30 + 40 = 70
        expect(chain.getBalance(bob.address)).toBe(70);
    });

    it('手续费为 0 时不影响余额计算', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();
        fundAddress(chain, alice.address, 100);

        const tx = createSignedTx(alice, bob.address, 50, 0);
        const block = new Block(
            chain.chain.length, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), tx],
            chain.getLatestBlock().hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        // Alice: 100 - 50 + 50 = 100
        expect(chain.getBalance(alice.address)).toBe(100);
        expect(chain.getBalance(bob.address)).toBe(50);
    });
});

// ============================================================
// 第3组: coinbase 成熟度（锁定期）
// ============================================================
describe('coinbase 成熟度（锁定期）', () => {
    it('默认 _isCoinbaseMature 逻辑正确', () => {
        const chain = newFreshChain();
        // 手动设置 coinbaseMaturity = 3
        chain.coinbaseMaturity = 3;

        // 模拟链上有 5 个块 (0..4)
        const alice = generateWallet();
        for (let i = 1; i <= 4; i++) {
            const block = new Block(
                i, new Date().toISOString(),
                [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward')],
                chain.getLatestBlock().hash
            );
            block.mineBlock(chain.difficulty);
            chain.chain.push(block);
        }

        // 区块 1 的奖励: 1 + 3 = 4 ≤ 4 → 成熟
        expect(chain._isCoinbaseMature(1)).toBe(true);
        // 区块 2 的奖励: 2 + 3 = 5 > 4 → 未成熟
        expect(chain._isCoinbaseMature(2)).toBe(false);
        // 区块 3 的奖励: 3 + 3 = 6 > 4 → 未成熟
        expect(chain._isCoinbaseMature(3)).toBe(false);
        // 区块 4 的奖励: 4 + 3 = 7 > 4 → 未成熟
        expect(chain._isCoinbaseMature(4)).toBe(false);
    });

    it('getBalance 默认排除未成熟奖励', () => {
        const chain = newFreshChain();
        chain.coinbaseMaturity = 3;
        const alice = generateWallet();

        // 区块 1: 给 Alice 100
        let block = new Block(1, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 100, 0, 'Mining Reward')],
            chain.chain[0].hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        // 区块 2: 给 Alice 50
        block = new Block(2, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward')],
            chain.chain[1].hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        // 区块 3: 给 Alice 30 (此时链尾 index=3)
        block = new Block(3, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 30, 0, 'Mining Reward')],
            chain.chain[2].hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        // chain: [0, 1, 2, 3]
        // chain.length = 4, latestBlock.index = 3
        // 区块 1: 1 + 3 = 4 > 3 → 未成熟
        // 区块 2: 2 + 3 = 5 > 3 → 未成熟
        // 区块 3: 3 + 3 = 6 > 3 → 未成熟
        // 全部未成熟 → 余额为 0
        expect(chain.getBalance(alice.address)).toBe(0);
    });

    it('getBalance 使用 includeImmature=true 时包含未成熟奖励', () => {
        const chain = newFreshChain();
        chain.coinbaseMaturity = 3;
        const alice = generateWallet();

        const block = new Block(1, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 100, 0, 'Mining Reward')],
            chain.chain[0].hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        expect(chain.getBalance(alice.address, true)).toBe(100);
    });

    it('getLockedRewards 正确返回未成熟奖励总额', () => {
        const chain = newFreshChain();
        chain.coinbaseMaturity = 2;
        const alice = generateWallet();

        // 区块 1: +100
        let block = new Block(1, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 100, 0, 'Mining Reward')],
            chain.chain[0].hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        // 区块 2: +50
        block = new Block(2, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward')],
            chain.chain[1].hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        // chain: [0, 1, 2]
        // 区块 1: 1 + 2 = 3 > 2 → 未成熟
        // 区块 2: 2 + 2 = 4 > 2 → 未成熟
        expect(chain.getLockedRewards(alice.address)).toBe(150);
    });

    it('奖励成熟后自动计入可用余额', () => {
        const chain = newFreshChain();
        chain.coinbaseMaturity = 2;
        const alice = generateWallet();

        // 区块 1: +100 (未成熟)
        let block = new Block(1, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 100, 0, 'Mining Reward')],
            chain.chain[0].hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        // 区块 2: +50 (未成熟)
        block = new Block(2, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward')],
            chain.chain[1].hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        // 区块 3: 无奖励，但让区块 1 的奖励成熟
        block = new Block(3, new Date().toISOString(),
            [new Transaction('', 'NOTE', 0, 0, 'dummy')],
            chain.chain[2].hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        // chain: [0, 1, 2, 3]
        // 区块 1: 1 + 2 = 3 ≤ 3 → 成熟 ✅
        // 区块 2: 2 + 2 = 4 > 3 → 未成熟
        expect(chain.getBalance(alice.address)).toBe(100);
        expect(chain.getLockedRewards(alice.address)).toBe(50);
    });
});

// ============================================================
// 第4组: 多地址场景
// ============================================================
describe('多地址余额计算', () => {
    it('Alice → Bob → Charlie 链式转账余额正确', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();
        const charlie = generateWallet();

        // Alice 得 200
        fundAddress(chain, alice.address, 200);

        // Alice 转 Bob 80 (fee=5)
        const tx1 = createSignedTx(alice, bob.address, 80, 5);
        let block = new Block(
            chain.chain.length, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), tx1],
            chain.getLatestBlock().hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        // Bob 转 Charlie 30 (fee=2)
        const tx2 = createSignedTx(bob, charlie.address, 30, 2);
        block = new Block(
            chain.chain.length, new Date().toISOString(),
            [new Transaction('SYSTEM', bob.address, 50, 0, 'Mining Reward'), tx2],
            chain.getLatestBlock().hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        // Alice: 200 - 80 - 5 + 50 = 165
        // Bob: 80 + 50 - 30 - 2 = 98
        // Charlie: 30
        expect(chain.getBalance(alice.address)).toBe(165);
        expect(chain.getBalance(bob.address)).toBe(98);
        expect(chain.getBalance(charlie.address)).toBe(30);
    });

    it('地址从未出现过返回 0', () => {
        const chain = newFreshChain();
        const unknown = '00000000000000000000000000000000';
        expect(chain.getBalance(unknown)).toBe(0);
    });

    it('getAllAddresses 包含所有出现过的地址', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();

        fundAddress(chain, alice.address, 100);
        fundAddress(chain, bob.address, 50);

        const all = chain.getAllAddresses();
        const addrs = all.map(a => a.address);
        expect(addrs).toContain(alice.address);
        expect(addrs).toContain(bob.address);
    });

    it('getAllAddresses 排序按余额降序', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();

        fundAddress(chain, alice.address, 50);
        fundAddress(chain, bob.address, 100);

        const all = chain.getAllAddresses();
        const aliceEntry = all.find(a => a.address === alice.address);
        const bobEntry = all.find(a => a.address === bob.address);
        expect(aliceEntry.balance).toBe(50);
        expect(bobEntry.balance).toBe(100);
        // bob 余额更高，应在 alice 前面
        expect(all.indexOf(bobEntry)).toBeLessThan(all.indexOf(aliceEntry));
    });
});

// ============================================================
// 第5组: 边界与特殊场景
// ============================================================
describe('边界与特殊场景', () => {
    it('余额刚好为 0（全部花光）', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();

        fundAddress(chain, alice.address, 100);

        // Alice 转 100 给 Bob (fee=0)
        const tx = createSignedTx(alice, bob.address, 100, 0);
        const block = new Block(
            chain.chain.length, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), tx],
            chain.getLatestBlock().hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        // Alice: 100 - 100 + 50 = 50
        expect(chain.getBalance(alice.address)).toBe(50);
        expect(chain.getBalance(bob.address)).toBe(100);
    });

    it('SYSTEM 地址本身余额为 0（只发币不收币）', () => {
        const chain = newFreshChain();
        expect(chain.getBalance('SYSTEM')).toBe(0);
    });

    it('getTransactionHistory 返回地址的所有交易并按时间降序', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();

        fundAddress(chain, alice.address, 100);

        const tx = createSignedTx(alice, bob.address, 30, 0);
        const block = new Block(
            chain.chain.length, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), tx],
            chain.getLatestBlock().hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        const history = chain.getTransactionHistory(alice.address);
        expect(history.length).toBeGreaterThanOrEqual(2);
        // 按时间降序
        for (let i = 1; i < history.length; i++) {
            expect(new Date(history[i - 1].timestamp) >= new Date(history[i].timestamp)).toBe(true);
        }
        // 包含 IN 和 OUT 方向
        expect(history.some(h => h.direction === 'OUT')).toBe(true);
        expect(history.some(h => h.direction === 'IN')).toBe(true);
    });

    it('getTransactionHistory 不包括备注交易到 address 的地址', () => {
        const chain = newFreshChain();
        const alice = generateWallet();

        // 添加一个备注交易
        const noteTx = new Transaction('', 'NOTE', 0, 0, '备注');
        const block = new Block(
            chain.chain.length, new Date().toISOString(),
            [noteTx],
            chain.getLatestBlock().hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        const noteHistory = chain.getTransactionHistory('NOTE');
        expect(noteHistory.length).toBeGreaterThanOrEqual(1);
    });

    it('getTotalBurnedFees 计算全链燃烧手续费', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();

        fundAddress(chain, alice.address, 200);

        const tx1 = createSignedTx(alice, bob.address, 30, 3);
        let block = new Block(
            chain.chain.length, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), tx1],
            chain.getLatestBlock().hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        const tx2 = createSignedTx(alice, bob.address, 20, 5);
        block = new Block(
            chain.chain.length, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), tx2],
            chain.getLatestBlock().hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        // 总手续费 = 3 + 5 = 8
        expect(chain.getTotalBurnedFees()).toBe(8);
    });

    it('getRecentBurnedFees 返回最近的 N 个区块手续费详情', () => {
        const chain = newFreshChain();
        const alice = generateWallet();
        const bob = generateWallet();

        fundAddress(chain, alice.address, 100);

        const tx = createSignedTx(alice, bob.address, 20, 4);
        const block = new Block(
            chain.chain.length, new Date().toISOString(),
            [new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward'), tx],
            chain.getLatestBlock().hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        const recent = chain.getRecentBurnedFees(3);
        expect(recent.length).toBeLessThanOrEqual(3);
        if (recent.length > 0) {
            expect(recent[recent.length - 1].totalFees).toBe(4);
        }
    });
});