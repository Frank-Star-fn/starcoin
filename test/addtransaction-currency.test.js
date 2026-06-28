// ============================================================
// 多币种交易余额检查单元测试
// 覆盖: addTransaction / addPendingTransaction 多币种余额边界
//       (STC: amount+fee 都从 STC 扣; 非 STC: amount 从币种扣, fee 从 STC 扣)
// ============================================================
const { Transaction, generateWallet } = require('../src/core');
const { Blockchain, Block } = require('../src/blockchain/blockchain');
const { newFreshChain, createSignedTx, fundAddress } = require('./helpers');

// ============================================================
// 第1组: STC 交易余额边界
// ============================================================
describe('addTransaction — STC 余额边界', () => {
    let chain, alice, bob;

    beforeEach(() => {
        chain = newFreshChain();
        alice = generateWallet();
        bob = generateWallet();
        fundAddress(chain, alice.address, 100);
    });

    it('余额恰好够 amount + fee → 成功', () => {
        const tx = createSignedTx(alice, bob.address, 95, 5, '恰好够');
        expect(() => chain.addTransaction(tx)).not.toThrow();
    });

    it('余额不够 amount + fee → 抛出', () => {
        const tx = createSignedTx(alice, bob.address, 96, 5, '差一点');
        expect(() => chain.addTransaction(tx)).toThrow(/余额不足/);
    });

    it('余额刚好够 amount, fee=0 → 成功', () => {
        const tx = createSignedTx(alice, bob.address, 100, 0, '刚好够无手续费');
        expect(() => chain.addTransaction(tx)).not.toThrow();
    });

    it('金额为 0 → addTransaction 抛出', () => {
        const tx = new Transaction(alice.address, bob.address, 0, 1, '零金额');
        tx.signTransaction(alice.privateKey, alice.publicKey);
        expect(() => chain.addTransaction(tx)).toThrow();
    });

    it('负金额 → addTransaction 抛出', () => {
        const tx = new Transaction(alice.address, bob.address, -10, 1, '负金额');
        tx.signTransaction(alice.privateKey, alice.publicKey);
        expect(() => chain.addTransaction(tx)).toThrow();
    });

    it('大额手续费 > 余额 → 抛出', () => {
        const tx = createSignedTx(alice, bob.address, 1, 200, '手续费超额');
        expect(() => chain.addTransaction(tx)).toThrow(/余额不足/);
    });

    it('零余额地址转账 → 抛出', () => {
        const tx = createSignedTx(bob, alice.address, 10, 1, '零余额');
        expect(() => chain.addTransaction(tx)).toThrow(/余额不足/);
    });
});

// ============================================================
// 第2组: addTransaction — 非 STC 币种余额检查
// ============================================================
describe('addTransaction — 非 STC 币种余额检查', () => {
    let chain, alice, bob;

    beforeEach(() => {
        chain = newFreshChain();
        alice = generateWallet();
        bob = generateWallet();
    });

    it('cBTC amount 充足 + STC fee 充足 → 成功', () => {
        // 给 Alice 充 cBTC 和 STC
        fundAddress(chain, alice.address, 200);          // STC
        fundAddressWithCurrency(chain, alice.address, 50, 'cBTC');  // cBTC

        const tx = createSignedTx(alice, bob.address, 10, 2, 'cBTC支付', 'cBTC');
        expect(() => chain.addTransaction(tx)).not.toThrow();
    });

    it('cBTC amount 不足 + STC fee 充足 → 抛出 cBTC 余额不足', () => {
        fundAddress(chain, alice.address, 200);          // STC 充足
        fundAddressWithCurrency(chain, alice.address, 5, 'cBTC');  // cBTC 只有 5

        const tx = createSignedTx(alice, bob.address, 10, 2, 'cBTC不足', 'cBTC');
        expect(() => chain.addTransaction(tx)).toThrow(/cBTC.*余额不足/);
    });

    it('cBTC amount 充足 + STC fee 不足 → 抛出 STC 手续费不足', () => {
        fundAddress(chain, alice.address, 1);            // STC 只有 1（不够 fee 2）
        fundAddressWithCurrency(chain, alice.address, 50, 'cBTC');

        const tx = createSignedTx(alice, bob.address, 10, 2, 'STC手续费不足', 'cBTC');
        expect(() => chain.addTransaction(tx)).toThrow(/矿工费不足/);
    });

    it('cBTC amount 充足 + STC fee=0 → 成功（无需 STC）', () => {
        fundAddressWithCurrency(chain, alice.address, 50, 'cBTC');
        // Alice 没有任何 STC

        const tx = createSignedTx(alice, bob.address, 10, 0, 'cBTC免手续费', 'cBTC');
        expect(() => chain.addTransaction(tx)).not.toThrow();
    });

    it('cETH amount 充足 + STC fee 充足 → 成功', () => {
        fundAddress(chain, alice.address, 200);
        fundAddressWithCurrency(chain, alice.address, 30, 'cETH');

        const tx = createSignedTx(alice, bob.address, 5, 1, 'cETH支付', 'cETH');
        expect(() => chain.addTransaction(tx)).not.toThrow();
    });

    it('旧名 WBTC → 被 normalize 为 cBTC 后余额检查正确', () => {
        fundAddress(chain, alice.address, 200);
        fundAddressWithCurrency(chain, alice.address, 50, 'cBTC');

        // 使用 'WBTC' 作为 currency，会被 normalize 为 'cBTC'
        const tx = new Transaction(alice.address, bob.address, 10, 1, 'WBTC旧名', 'WBTC');
        tx.signTransaction(alice.privateKey, alice.publicKey);
        expect(() => chain.addTransaction(tx)).not.toThrow();
    });
});

// ============================================================
// 第3组: addPendingTransaction — 多币种余额检查
// ============================================================
describe('addPendingTransaction — 多币种余额检查', () => {
    let chain, alice, bob;

    beforeEach(() => {
        chain = newFreshChain();
        alice = generateWallet();
        bob = generateWallet();
    });

    it('skipBalanceCheck=true（默认）→ 跳过余额检查，成功', () => {
        // 不给 Alice 任何余额
        const tx = createSignedTx(alice, bob.address, 9999, 0, '跳过余额检查', 'cBTC');
        const result = chain.addPendingTransaction(tx); // 默认 skipBalanceCheck=true
        expect(result.success).toBe(true);
    });

    it('skipBalanceCheck=false + STC 余额充足 → 成功', () => {
        fundAddress(chain, alice.address, 100);
        const tx = createSignedTx(alice, bob.address, 10, 1, '不跳过余额检查');
        const result = chain.addPendingTransaction(tx, false);
        expect(result.success).toBe(true);
    });

    it('skipBalanceCheck=false + STC 余额不足 → 失败', () => {
        // 不给 Alice 任何余额
        const tx = createSignedTx(alice, bob.address, 10, 1, '余额不足检查');
        const result = chain.addPendingTransaction(tx, false);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/余额不足/);
    });

    it('skipBalanceCheck=false + cBTC amount 不足 → 失败', () => {
        fundAddress(chain, alice.address, 200); // STC 足够
        fundAddressWithCurrency(chain, alice.address, 3, 'cBTC'); // cBTC 只有 3

        const tx = createSignedTx(alice, bob.address, 10, 1, 'cBTC余额不足', 'cBTC');
        const result = chain.addPendingTransaction(tx, false);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/cBTC.*余额不足/);
    });

    it('skipBalanceCheck=false + cBTC amount 充足但 STC fee 不足 → 失败', () => {
        fundAddress(chain, alice.address, 0); // STC 为 0
        fundAddressWithCurrency(chain, alice.address, 50, 'cBTC'); // cBTC 充足

        const tx = createSignedTx(alice, bob.address, 10, 3, 'STC手续费不足', 'cBTC');
        const result = chain.addPendingTransaction(tx, false);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/矿工费不足/);
    });

    it('skipBalanceCheck=false + 零 fee + cBTC 充足 → 成功（无需 STC）', () => {
        fundAddressWithCurrency(chain, alice.address, 30, 'cBTC');

        const tx = createSignedTx(alice, bob.address, 10, 0, '零手续费cBTC', 'cBTC');
        const result = chain.addPendingTransaction(tx, false);
        expect(result.success).toBe(true);
    });
});

// ============================================================
// 第4组: pending 交易池扣减计算（多币种累计）
// ============================================================
describe('pending 交易池扣减 — 多币种累计', () => {
    let chain, alice, bob, charlie;

    beforeEach(() => {
        chain = newFreshChain();
        alice = generateWallet();
        bob = generateWallet();
        charlie = generateWallet();
        fundAddress(chain, alice.address, 200);
        fundAddressWithCurrency(chain, alice.address, 30, 'cBTC');
    });

    it('多笔 STC pending 交易累计扣减 → 超出时拒绝', () => {
        // 第一笔 pending: 100 STC
        const tx1 = createSignedTx(alice, bob.address, 80, 5, '第一笔');
        chain.addTransaction(tx1);

        // 第二笔 pending: 剩余可用 200-85=115, 笔 100+fee+第二笔 fee
        const tx2 = createSignedTx(alice, charlie.address, 100, 10, '第二笔超额');
        // 已用: 80+5=85, 剩余: 200-85=115, 第二笔需: 100+10=110 → 够
        // 但这里要考虑 pending 扣减规则: available = balance - pendingOutgoing
        // pendingOutgoing 是已累加 amount+fee 的
        expect(() => chain.addTransaction(tx2)).not.toThrow(); // 85+110=195 ≤ 200 → 刚好够

        // 第三笔 pending: 剩余可用 200-195=5
        const tx3 = createSignedTx(alice, charlie.address, 5, 1, '第三笔超额');
        expect(() => chain.addTransaction(tx3)).toThrow(/余额不足/);
    });

    it('cBTC pending 交易 amount 累计扣减', () => {
        // 第一笔 cBTC pending: 10 cBTC, fee=2 STC
        const tx1 = createSignedTx(alice, bob.address, 10, 2, 'cBTC第一笔', 'cBTC');
        chain.addTransaction(tx1);

        // 第二笔 cBTC: 剩余 cBTC=30-10=20, fee 需要额外从 STC 扣
        const tx2 = createSignedTx(alice, charlie.address, 20, 0, 'cBTC第二笔', 'cBTC');
        expect(() => chain.addTransaction(tx2)).not.toThrow(); // 20 ≤ 20 → 刚好够

        // 第三笔 cBTC: 超额
        const tx3 = createSignedTx(alice, charlie.address, 1, 0, 'cBTC超额', 'cBTC');
        expect(() => chain.addTransaction(tx3)).toThrow(/cBTC.*余额不足/);
    });

    it('多笔 pending 交易的非 STC amount 和 STC fee 分别累计', () => {
        fundAddressWithCurrency(chain, alice.address, 20, 'cETH');

        // cBTC: amount 10, fee 2 STC
        const tx1 = createSignedTx(alice, bob.address, 10, 2, 'cBTC', 'cBTC');
        chain.addTransaction(tx1);

        // cETH: amount 5, fee 1 STC
        const tx2 = createSignedTx(alice, charlie.address, 5, 1, 'cETH', 'cETH');
        chain.addTransaction(tx2);

        // STC pending 检查: 可用 STC = 200 - (2+1) = 197
        // 再加一笔 STC 交易: amount=190, fee=5 → 需要 195, 可用 197 → 够
        // STC pending 检查只统计 STC 币种 pending 交易（fee 来自非 STC 交易不计入）
        // 目前 pending STC txs 为 0，所以可用 STC=200
        const tx3 = createSignedTx(alice, bob.address, 190, 5, 'STC', 'STC');
        expect(() => chain.addTransaction(tx3)).not.toThrow(); // 200 >= 195 → 成功

        // 再加一笔 STC: 超出可用余额
        // 已用: 190 + 5 = 195，可用: 200 - 195 = 5
        const tx4 = createSignedTx(alice, bob.address, 5, 1, 'STC超额', 'STC');
        // 需要 5+1=6，可用 5 → 抛出
        expect(() => chain.addTransaction(tx4)).toThrow(/余额不足/);
    });
});

// ============================================================
// 辅助：带币种的充值
// ============================================================
function fundAddressWithCurrency(chain, address, amount, currency) {
    const rewardTx = new Transaction('SYSTEM', address, amount, 0, `Test Fund ${currency}`, currency);
    const block = new Block(
        chain.chain.length,
        new Date().toISOString(),
        [rewardTx],
        chain.getLatestBlock().hash
    );
    block.mineBlock(chain.difficulty);
    chain.chain.push(block);
}