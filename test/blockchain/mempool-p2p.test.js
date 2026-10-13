const { generateWallet, Transaction } = require('../../src/core');
const { newFreshChain, createSignedTx } = require('../helpers');

function copy(chain) { const fork = newFreshChain(chain.consensus.params); fork.chain = JSON.parse(JSON.stringify(chain.chain)); return fork; }
describe('P2P 交易池与区块确认', () => {
    let chain, alice;
    beforeEach(() => { chain = newFreshChain(); alice = generateWallet(); chain.mineBlock(alice.address); });
    it('空交易池不存在交易', () => { expect(chain.hasPendingTransaction('unknown')).toBe(false); });
    it('成功接收签名且有余额的网络交易', () => {
        const tx = createSignedTx(alice, 'bob', 10);
        expect(chain.addPendingTransaction(JSON.parse(JSON.stringify(tx))).success).toBe(true);
        expect(chain.hasPendingTransaction(tx.id)).toBe(true);
        expect(chain.hasPendingTransaction('unknown')).toBe(false);
    });
    it('多个连续 nonce 的交易可以依次入池', () => {
        const a = createSignedTx(alice, 'bob', 10), b = createSignedTx(alice, 'charlie', 10, 0, '', 'STC', 1);
        expect(chain.addPendingTransaction(a).success).toBe(true); expect(chain.addPendingTransaction(b).success).toBe(true);
        expect(chain.pendingTransactions).toHaveLength(2);
    });
    it.each([true, false])('skipBalanceCheck=%s 也不能跳过余额检查', flag => {
        expect(chain.addPendingTransaction(createSignedTx(alice, 'bob', 51), flag).success).toBe(false);
    });
    it('不能接收 SYSTEM 奖励', () => {
        expect(chain.addPendingTransaction(chain.buildCandidate('attacker').block.transactions[0]).success).toBe(false);
    });
    it('重复 ID 和重复 JSON 广播均被拒绝', () => {
        const tx = createSignedTx(alice, 'bob', 10); chain.addPendingTransaction(tx);
        expect(chain.addPendingTransaction(tx).success).toBe(false);
        expect(chain.addPendingTransaction(JSON.parse(JSON.stringify(tx))).success).toBe(false);
        expect(chain.pendingTransactions).toHaveLength(1);
    });
    it.each(['signature', 'from', 'amount', 'self'])('拒绝非法字段 %s', field => {
        const tx = createSignedTx(alice, 'bob', 10);
        if (field === 'signature') tx.signature = 'a'.repeat(64);
        if (field === 'from') tx.from = '';
        if (field === 'amount') tx.amount = 0;
        if (field === 'self') { tx.to = tx.from; tx.signTransaction(alice.privateKey, alice.publicKey); }
        expect(chain.addPendingTransaction(tx).success).toBe(false);
    });
    it('缺失或畸形交易不会抛出网络层异常', () => {
        for (const value of [null, undefined, {}, [], 1]) expect(chain.addPendingTransaction(value).success).toBe(false);
    });
    it('确认交易自动从交易池移除', () => {
        const tx = createSignedTx(alice, 'bob', 10); chain.addPendingTransaction(tx); chain.mineBlock('miner');
        expect(chain.hasPendingTransaction(tx.id)).toBe(false);
    });
    it('不含池中交易的外部有效区块不删除该交易', () => {
        const fork = copy(chain), tx = createSignedTx(alice, 'bob', 10); chain.addPendingTransaction(tx);
        expect(chain.addBlock(fork.mineBlock('miner'))).toBeTruthy(); expect(chain.hasPendingTransaction(tx.id)).toBe(true);
    });
    it('同步新链后已确认的交易不再留在池中', () => {
        const fork = copy(chain), tx = createSignedTx(alice, 'bob', 10);
        chain.addPendingTransaction(tx); fork.addPendingTransaction(tx); fork.mineBlock('miner');
        expect(chain.replaceChain(fork.chain)).toBe(true); expect(chain.hasPendingTransaction(tx.id)).toBe(false);
    });
    it('有效的旧分支交易回滚后保留全部签名字段', () => {
        const fork = copy(chain), tx = createSignedTx(alice, 'bob', 10);
        chain.addPendingTransaction(tx); chain.mineBlock('old');
        fork.mineBlock('new'); fork.mineBlock('new'); chain.replaceChain(fork.chain);
        expect(chain.pendingTransactions[0]).toEqual(tx); expect(Transaction.fromJSON(chain.pendingTransactions[0]).isValid()).toBe(true);
    });
});
