const { generateWallet } = require('../../src/core');
const { newFreshChain, createSignedTx } = require('../helpers');
function clone(chain) { const fork = newFreshChain(chain.consensus.params); fork.chain = JSON.parse(JSON.stringify(chain.chain)); return fork; }
function grow(chain, count, miner = 'miner') { for (let i = 0; i < count; i++) chain.mineBlock(miner); }

describe('有效链验证和自动修复', () => {
    let chain;
    beforeEach(() => { chain = newFreshChain(); });
    it('空链无效，缺省或 null 验证本地链', () => {
        expect(chain.isChainValid([])).toBe(false); expect(chain.isChainValid()).toBe(true); expect(chain.isChainValid(null)).toBe(true);
    });
    it('连续区块及 JSON 反序列化链都有效', () => {
        grow(chain, 4); expect(chain.isChainValid()).toBe(true); expect(chain.isChainValid(JSON.parse(JSON.stringify(chain.chain)))).toBe(true);
    });
    it.each(['hash', 'previousHash', 'index', 'merkleRoot', 'genesis'])('检测 %s 篡改', field => {
        grow(chain, 3);
        if (field === 'genesis') chain.chain[0].hash = 'a'.repeat(64);
        else if (field === 'index') chain.chain[2].index = 99;
        else chain.chain[2][field] = 'a'.repeat(64);
        expect(chain.isChainValid()).toBe(false);
    });
    it('有效链不触发修复', () => { grow(chain, 3); expect(chain.repairChain()).toEqual([]); });
    it.each([1, 2, 3])('从损坏高度 %s 截断并保留有效前缀', index => {
        grow(chain, 3); chain.chain[index].hash = 'f'.repeat(64);
        expect(chain.repairChain()).toHaveLength(4 - index);
        expect(chain.chain).toHaveLength(index); expect(chain.isChainValid()).toBe(true);
    });
    it('创世块损坏拒绝自动重置', () => {
        chain.chain[0].hash = 'a'.repeat(64); expect(() => chain.repairChain()).toThrow(/创世块/);
    });
    it('修复也检测签名错误而不是只检查哈希', () => {
        const alice = generateWallet(); chain.mineBlock(alice.address); const tx = createSignedTx(alice, 'bob', 1);
        chain.addTransaction(tx); chain.mineBlock('miner'); chain.chain[2].transactions[1].signature = 'a'.repeat(64);
        expect(chain.repairChain()).toHaveLength(1); expect(chain.pendingTransactions).toHaveLength(0);
    });
});

describe('工作量选链与分叉回滚', () => {
    let chain, fork, alice;
    beforeEach(() => { chain = newFreshChain(); alice = generateWallet(); chain.mineBlock(alice.address); fork = clone(chain); });
    it('相同工作量保持当前链', () => {
        chain.mineBlock('old'); fork.mineBlock('new'); expect(chain.replaceChain(fork.chain)).toBe(false);
    });
    it('更高工作量有效链被采用并更新难度', () => {
        grow(fork, 3); expect(chain.replaceChain(fork.chain)).toBe(true);
        expect(chain.getLatestBlock().hash).toBe(fork.getLatestBlock().hash);
        expect(chain.difficulty).toBe(fork.evaluateChain().difficulty);
    });
    it('无效长链不影响当前链或交易池', () => {
        const tx = createSignedTx(alice, 'bob', 1); chain.addTransaction(tx); grow(fork, 3);
        fork.chain[2].hash = 'f'.repeat(64); const tip = chain.getLatestBlock().hash;
        expect(chain.replaceChain(fork.chain)).toBe(false); expect(chain.getLatestBlock().hash).toBe(tip); expect(chain.pendingTransactions).toHaveLength(1);
    });
    it('回滚用户交易、不回滚奖励，余额恢复正确', () => {
        const tx = createSignedTx(alice, 'bob', 20, 1); chain.addTransaction(tx); chain.mineBlock('old');
        grow(fork, 2, 'new'); expect(chain.replaceChain(fork.chain)).toBe(true);
        expect(chain.getBalance(alice.address)).toBe(50); expect(chain.getBalance('bob')).toBe(0);
        expect(chain.pendingTransactions).toEqual([tx]); expect(chain.pendingTransactions.some(t => t.from === 'SYSTEM')).toBe(false);
    });
    it('新链已确认的交易不会重复回滚', () => {
        const tx = createSignedTx(alice, 'bob', 20); chain.addTransaction(tx); chain.mineBlock('old');
        fork.addTransaction(tx); grow(fork, 2, 'new'); chain.replaceChain(fork.chain);
        expect(chain.pendingTransactions).toHaveLength(0); expect(chain.getBalance('bob')).toBe(20);
    });
    it('重复候选只保留一次，nonce 依赖按顺序重建', () => {
        const tx = createSignedTx(alice, 'bob', 20); chain.addTransaction(tx); chain.mineBlock('old');
        chain.pendingTransactions.push(tx, tx); grow(fork, 2, 'new'); chain.replaceChain(fork.chain);
        expect(chain.pendingTransactions).toEqual([tx]);
    });
    it('新分支消费同一 nonce 后旧交易不能再打包', () => {
        const tx = createSignedTx(alice, 'bob', 20); chain.addTransaction(tx); chain.mineBlock('old');
        fork.addTransaction(createSignedTx(alice, 'charlie', 20)); grow(fork, 2, 'new'); chain.replaceChain(fork.chain);
        expect(chain.pendingTransactions).toHaveLength(0); expect(chain.getTransactionStatus(tx.id).status).toBe('reverted');
    });
});
