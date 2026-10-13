const { Blockchain, Block, Transaction, generateWallet } = require('../../src/blockchain/blockchain');
const { restoreBlock, cloneState } = require('../../src/consensus');
const { toUnits, targetForDifficulty, targetHex, meetsTarget } = require('../../src/protocol');
const { createMessageHandlers } = require('../../src/p2p/p2p-message-handlers');

const params = { initialDifficulty: 1, difficultyMin: 0, coinbaseMaturity: 0, difficultyAdjustInterval: 1000000 };
function fresh(overrides = {}) { return new Blockchain(9876, true, { consensus: { ...params, ...overrides } }); }
function signed(chain, wallet, to, amount, nonce = 0, fee = 0, currency = 'STC') {
    const tx = chain.createTransaction(wallet.address, to, amount, fee, '', currency, nonce);
    tx.signTransaction(wallet.privateKey, wallet.publicKey); return tx;
}
function seal(chain, block) {
    block.updateMerkleRoot(); block.nonce = 0; block.hash = block.calculateHash();
    block.mineBlock(chain.evaluateChain().difficulty); return block;
}
function candidate(chain, transactions) {
    const { block } = chain.buildCandidate('miner');
    if (transactions) block.transactions = [block.transactions[0], ...transactions];
    return seal(chain, block);
}
function branchCopy(chain) {
    const other = fresh(chain.consensus.params);
    other.chain = chain.chain.map(restoreBlock); other.recalculateDifficulty(); return other;
}

describe('统一验证拒绝双花与重放', () => {
    let chain, alice;
    beforeEach(() => { chain = fresh(); alice = generateWallet(); chain.mineBlock(alice.address); });

    it('HTTP 和 P2P 入池都拒绝同一 nonce 的不同支付', () => {
        chain.addTransaction(signed(chain, alice, 'bob', 20));
        expect(() => chain.addTransaction(signed(chain, alice, 'charlie', 20))).toThrow(/nonce/);
        expect(chain.addPendingTransaction(signed(chain, alice, 'charlie', 20), true).success).toBe(false);
    });
    it('连续 nonce 也不能累计透支余额', () => {
        chain.addTransaction(signed(chain, alice, 'bob', 30));
        expect(() => chain.addTransaction(signed(chain, alice, 'charlie', 30, 1))).toThrow(/余额不足/);
    });
    it('忽略旧 skipBalanceCheck 参数，拒绝网络透支交易', () => {
        expect(chain.addPendingTransaction(signed(chain, alice, 'bob', 51), true).success).toBe(false);
    });
    it('同一笔已确认交易不能再次入池或再次入块', () => {
        const tx = signed(chain, alice, 'bob', 10); chain.addTransaction(tx); chain.mineBlock('miner');
        expect(() => chain.addTransaction(tx)).toThrow(/已确认|重复/);
        expect(chain.addBlock(candidate(chain, [tx]))).toBeNull();
    });
    it('改变交易 ID 不能重放原签名', () => {
        const tx = signed(chain, alice, 'bob', 10); tx.id = 'a'.repeat(64);
        expect(chain.addPendingTransaction(tx).success).toBe(false);
    });
    it('合法签名的重复 nonce 直接入块也被拒绝', () => {
        const block = candidate(chain, [signed(chain, alice, 'bob', 10), signed(chain, alice, 'charlie', 10)]);
        expect(chain.addBlock(block)).toBeNull();
        expect(chain.replaceChain([...chain.chain, block])).toBe(false);
    });
    it('合法签名、连续 nonce 的直接区块透支也被拒绝', () => {
        expect(chain.addBlock(candidate(chain, [signed(chain, alice, 'bob', 30), signed(chain, alice, 'charlie', 30, 1)]))).toBeNull();
    });
    it('区块内交易不能重复出现', () => {
        const tx = signed(chain, alice, 'bob', 10);
        expect(chain.addBlock(candidate(chain, [tx, tx]))).toBeNull();
    });
    it.each([undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('拒绝非法 nonce %s', nonce => {
        const tx = signed(chain, alice, 'bob', 1); tx.nonce = nonce; tx.signTransaction(alice.privateKey, alice.publicKey);
        expect(chain.addPendingTransaction(tx).success).toBe(false);
    });
    it('错误 chainId 即使重新签名也不能使用', () => {
        const tx = signed(chain, alice, 'bob', 1); tx.chainId = 'other-chain'; tx.signTransaction(alice.privateKey, alice.publicKey);
        expect(chain.addPendingTransaction(tx).success).toBe(false);
    });
    it('激活后拒绝无 nonce 的旧签名格式', () => {
        const tx = new Transaction(alice.address, 'bob', 1); tx.signTransaction(alice.privateKey, alice.publicKey);
        expect(chain.addPendingTransaction(tx).success).toBe(false);
        expect(chain.addBlock(candidate(chain, [tx]))).toBeNull();
    });
    it('字段分隔不同不会产生旧式字符串拼接碰撞', () => {
        const tx = signed(chain, alice, 'ab', 1), altered = Transaction.fromJSON(tx);
        altered.to = 'a'; altered.note = 'b';
        expect(altered.calculateHash()).not.toBe(tx.calculateHash());
    });
});

describe('金额、特殊交易与 PoW', () => {
    it.each([NaN, Infinity, -1, '0.000000001', true, null, '99999999999999999999'])('拒绝无效金额 %s', amount => {
        expect(() => toUnits(amount)).toThrow();
    });
    it('八位小数和科学记数数字精确转换', () => {
        expect(toUnits('0.12345678')).toBe(12345678n);
        expect(toUnits(1e-8)).toBe(1n);
    });
    it('不同币种都预留 STC 手续费，不能重复使用已预留 STC', () => {
        const chain = fresh(), alice = generateWallet(); chain.mineBlock(alice.address);
        const evaluation = chain.evaluateChain(); evaluation.state.balances.set(alice.address + ':cBTC', toUnits(10));
        const a = signed(chain, alice, 'bob', 45, 0, 1), b = signed(chain, alice, 'charlie', 1, 1, 5, 'cBTC');
        const pool = chain.consensus.rebuildPool(evaluation, [a, b]);
        expect(pool.pending.map(tx => tx.id)).toEqual([a.id]);
        expect(pool.rejected[0].error).toMatch(/矿工费不足/);
    });
    it('先预留代币手续费后，STC 转账也不能透支', () => {
        const chain = fresh(), alice = generateWallet(); chain.mineBlock(alice.address);
        const evaluation = chain.evaluateChain(); evaluation.state.balances.set(alice.address + ':cBTC', toUnits(10));
        const pool = chain.consensus.rebuildPool(evaluation, [signed(chain, alice, 'bob', 1, 0, 10, 'cBTC'), signed(chain, alice, 'charlie', 41, 1)]);
        expect(pool.pending).toHaveLength(1);
    });
    it('非法候选交易不能留下部分扣款', () => {
        const chain = fresh(), alice = generateWallet(); chain.mineBlock(alice.address);
        const evaluation = chain.evaluateChain(); evaluation.state.balances.set('bob:STC', (1n << 63n) - 1n);
        const state = cloneState(evaluation.state);
        expect(() => chain.consensus.applyTransfer(state, signed(chain, alice, 'bob', 1), chain.chain.length)).toThrow();
        const block = candidate(chain, [signed(chain, alice, 'bob', 1)]);
        expect(chain.addBlock(block)).toBeTruthy(); // Failed trial cannot mutate the real chain state.
    });
    it('SYSTEM 与备注交易不能通过网络交易池入账', () => {
        const chain = fresh();
        expect(chain.addPendingTransaction(chain.buildCandidate('attacker').block.transactions[0], true).success).toBe(false);
        expect(chain.addPendingTransaction(new Transaction('', 'NOTE', 0)).success).toBe(false);
    });
    it.each(['amount', 'currency', 'duplicate', 'position', 'emptySender', 'missing'])('拒绝伪造奖励：%s', attack => {
        const chain = fresh(), block = candidate(chain), reward = block.transactions[0];
        if (attack === 'amount') reward.amount = 500;
        if (attack === 'currency') reward.currency = 'cBTC';
        if (attack === 'duplicate') block.transactions.push(Transaction.fromJSON(reward));
        if (attack === 'position') block.transactions.unshift(new Transaction('', 'NOTE', 0));
        if (attack === 'emptySender') reward.from = '';
        if (attack === 'missing') block.transactions = [];
        reward.id = reward.calculateHash();
        expect(chain.addBlock(seal(chain, block))).toBeNull();
    });
    it('奖励未成熟时，直接提交签名区块也不能支出', () => {
        const chain = fresh({ coinbaseMaturity: 3 }), alice = generateWallet(); chain.mineBlock(alice.address);
        const tx = signed(chain, alice, 'bob', 1);
        expect(chain.addPendingTransaction(tx).success).toBe(false);
        expect(chain.addBlock(candidate(chain, [tx]))).toBeNull();
        chain.mineBlock('miner'); chain.mineBlock('miner'); chain.mineBlock('miner');
        expect(chain.addPendingTransaction(tx).success).toBe(true);
    });
    it('篡改交易内容、保留原 Merkle 根，不能绕过验证', () => {
        const chain = fresh(), block = candidate(chain); block.transactions[0].amount = 999;
        block.transactions[0].id = block.transactions[0].calculateHash();
        expect(block.hash).toBe(block.calculateHash());
        expect(chain.addBlock(JSON.parse(JSON.stringify(block)))).toBeNull();
    });
    it('收到的原始 hash 不会在反序列化时被覆盖', () => {
        const chain = fresh(), block = candidate(chain); block.hash = 'f'.repeat(64);
        expect(chain.addBlock(JSON.parse(JSON.stringify(block)))).toBeNull();
        expect(chain.isChainValid([...chain.chain, block])).toBe(false);
    });
    it('计算正确的哈希仍必须满足 PoW', () => {
        const chain = fresh(), { block } = chain.buildCandidate('miner');
        while (meetsTarget(block.hash, BigInt('0x' + block.target))) { block.nonce++; block.hash = block.calculateHash(); }
        expect(chain.addBlock(block)).toBeNull();
    });
    it.each(['height', 'parent', 'target', 'consensus', 'future', 'median', 'nonce'])('拒绝非法区块头：%s', attack => {
        const chain = fresh(), block = candidate(chain);
        if (attack === 'height') block.index += 1;
        if (attack === 'parent') block.previousHash = 'f'.repeat(64);
        if (attack === 'target') block.target = 'f'.repeat(64);
        if (attack === 'consensus') block.consensusHash = 'a'.repeat(64);
        if (attack === 'future') block.timestamp = new Date(Date.now() + 3600000).toISOString();
        if (attack === 'median') block.timestamp = chain.chain[0].timestamp;
        if (attack === 'nonce') block.nonce = 0.5;
        block.hash = block.calculateHash();
        expect(chain.addBlock(block)).toBeNull();
    });
    it('小数难度在整数边界前后单调', () => {
        const values = [0, 0.1, 0.9, 0.9999, 1, 1.0001, 1.5, 1.9999, 2];
        for (let i = 1; i < values.length; i++) expect(targetForDifficulty(values[i])).toBeLessThan(targetForDifficulty(values[i - 1]));
    });
    it('创世内容和哈希一起重算也不能改变固定创世锚点', () => {
        const chain = fresh(), genesis = chain.chain[0];
        genesis.transactions[0].amount = 100; genesis.updateMerkleRoot(); genesis.hash = genesis.calculateHash();
        expect(chain.isChainValid()).toBe(false);
    });
});

describe('打包、工作量、重组与收款状态', () => {
    it('高费用后继交易必须等待同地址前序 nonce', () => {
        const chain = fresh(), alice = generateWallet(); chain.mineBlock(alice.address);
        const first = signed(chain, alice, 'bob', 1, 0, 1), second = signed(chain, alice, 'bob', 1, 1, 10);
        chain.addTransaction(first); chain.addTransaction(second);
        expect(chain.mineBlock('miner').transactions.slice(1).map(tx => tx.id)).toEqual([first.id, second.id]);
    });
    it('恶意直接修改交易池的交易不能被打包', () => {
        const chain = fresh(), alice = generateWallet(); chain.mineBlock(alice.address);
        chain.pendingTransactions.push(signed(chain, alice, 'bob', 51));
        expect(chain.mineBlock('miner').transactions).toHaveLength(1);
        expect(chain.pendingTransactions).toHaveLength(0);
    });
    it('最终挖矿回调期间链尾变化，不提交过期区块', async () => {
        const chain = fresh(), alice = generateWallet(); chain.mineBlock(alice.address);
        const tx = signed(chain, alice, 'bob', 1); chain.addTransaction(tx);
        const next = candidate(chain, []);
        const result = await chain.mineBlockAsync('miner', '', progress => { if (progress.found) chain.addBlock(next); });
        expect(result.canceled).toBe(true);
        expect(chain.getLatestBlock().hash).toBe(next.hash);
        expect(chain.pendingTransactions.map(t => t.id)).toContain(tx.id);
    });
    it('磁盘保存失败不提交链或清空交易池', () => {
        const chain = fresh(), alice = generateWallet(); chain.mineBlock(alice.address);
        const tx = signed(chain, alice, 'bob', 1); chain.addTransaction(tx);
        const oldTip = chain.getLatestBlock().hash;
        vi.spyOn(chain.storage, 'saveToFile').mockReturnValue(false);
        expect(() => chain.mineBlock('miner')).toThrow(/持久化失败/);
        expect(chain.getLatestBlock().hash).toBe(oldTip);
        expect(chain.pendingTransactions.map(t => t.id)).toEqual([tx.id]);
    });
    it('重组后保留完整交易字段并重新验证余额', () => {
        const chain = fresh(), alice = generateWallet(); chain.mineBlock(alice.address);
        const fork = branchCopy(chain), tx = signed(chain, alice, 'bob', 10, 0, 1);
        chain.addTransaction(tx); chain.mineBlock('old-miner');
        fork.mineBlock('new-miner'); fork.mineBlock('new-miner');
        expect(chain.replaceChain(fork.chain)).toBe(true);
        const restored = chain.pendingTransactions.find(t => t.id === tx.id);
        expect(restored).toEqual(tx); expect(restored.isValid()).toBe(true);
        expect(chain.getTransactionStatus(tx.id).wasReverted).toBe(true);
        chain.mineBlock('miner'); expect(chain.getTransactionStatus(tx.id).status).toBe('included');
    });
    it('重组后冲突 nonce 的旧交易被剔除', () => {
        const chain = fresh(), alice = generateWallet(); chain.mineBlock(alice.address); const fork = branchCopy(chain);
        const old = signed(chain, alice, 'bob', 20); chain.addTransaction(old); chain.mineBlock('old-miner');
        fork.addTransaction(signed(fork, alice, 'charlie', 20)); fork.mineBlock('new-miner'); fork.mineBlock('new-miner');
        expect(chain.replaceChain(fork.chain)).toBe(true);
        expect(chain.pendingTransactions).toHaveLength(0);
        expect(chain.getTransactionStatus(old.id).status).toBe('reverted');
        expect(chain.getBalance('bob')).toBe(0); expect(chain.getBalance('charlie')).toBe(20);
    });
    it('被回滚奖励提供的余额不能留在交易池', () => {
        const chain = fresh(), fork = fresh(), alice = generateWallet(); chain.mineBlock(alice.address);
        const tx = signed(chain, alice, 'bob', 20); chain.addTransaction(tx);
        fork.mineBlock('other-miner'); fork.mineBlock('other-miner');
        expect(chain.replaceChain(fork.chain)).toBe(true); expect(chain.pendingTransactions).toHaveLength(0);
    });
    it('低工作量的合法长链不能替换高工作量短链，网络入口也接受强短链', () => {
        const settings = { difficultyAdjustInterval: 3, difficultyStep: 1, difficultyMax: 3 };
        const short = fresh(settings), long = fresh(settings);
        const base = Date.now() - 100000;
        function grow(chain, count, seconds) {
            for (let i = 0; i < count; i++) {
                const { block } = chain.buildCandidate('miner'); block.timestamp = new Date(base + i * seconds * 1000).toISOString();
                const reward = block.transactions[0]; reward.timestamp = block.timestamp; reward.id = reward.calculateHash();
                expect(chain.addBlock(seal(chain, block))).toBeTruthy();
            }
        }
        grow(short, 4, 1); grow(long, 6, 20);
        expect(short.chain.length).toBeLessThan(long.chain.length);
        expect(short.getChainWork()).toBeGreaterThan(long.getChainWork());
        expect(short.replaceChain(long.chain)).toBe(false);
        const network = { broadcast: vi.fn(), nodeInfo: {}, nodes: new Set() };
        const handlers = createMessageHandlers(network, long);
        handlers.handleBlockResponse(short.getLatestBlock());
        expect(network.broadcast).toHaveBeenCalledWith({ type: 'QUERY_ALL' });
        handlers.handleChainResponse(JSON.parse(JSON.stringify(short.chain)));
        expect(long.getLatestBlock().hash).toBe(short.getLatestBlock().hash);
    });
    it('三个节点在冲突分支后收敛，重复广播不改变账本', () => {
        const a = fresh(), alice = generateWallet(); a.mineBlock(alice.address);
        const b = branchCopy(a), c = branchCopy(a);
        a.addTransaction(signed(a, alice, 'bob', 20)); a.mineBlock('a');
        b.addTransaction(signed(b, alice, 'charlie', 20)); b.mineBlock('b'); b.mineBlock('b');
        for (const node of [a, c]) {
            const handler = createMessageHandlers({ broadcast() {}, nodeInfo: {}, nodes: new Set() }, node);
            handler.handleChainResponse(JSON.parse(JSON.stringify(b.chain)));
            handler.handleChainResponse(JSON.parse(JSON.stringify(b.chain)));
            expect(node.getLatestBlock().hash).toBe(b.getLatestBlock().hash);
            expect(node.getBalance('bob')).toBe(0); expect(node.getBalance('charlie')).toBe(20);
        }
    });
    it('确认从入块的 1 开始，阈值后达到 confirmed', () => {
        const chain = fresh(), alice = generateWallet(); chain.paymentConfirmations = 2; chain.mineBlock(alice.address);
        const tx = signed(chain, alice, 'bob', 1); chain.addTransaction(tx);
        expect(chain.getTransactionStatus(tx.id).status).toBe('pending');
        chain.mineBlock('miner'); expect(chain.getTransactionStatus(tx.id).confirmations).toBe(1);
        chain.mineBlock('miner'); expect(chain.getTransactionStatus(tx.id).status).toBe('confirmed');
    });
    it('深度重组记录告警但保持工作量共识', () => {
        const chain = fresh(), fork = fresh(); chain.deepReorgThreshold = 1;
        chain.mineBlock('old'); fork.mineBlock('new'); fork.mineBlock('new');
        const log = vi.spyOn(chain.sync.log, 'error');
        expect(chain.replaceChain(fork.chain)).toBe(true);
        expect(chain.reorgEvents.at(-1).deep).toBe(true); expect(log).toHaveBeenCalled();
    });
});

module.exports = { fresh, signed, candidate, params };
