const { generateWallet } = require('../../src/core');
const { toUnits } = require('../../src/protocol');
const { newFreshChain, createSignedTx } = require('../helpers');

function ledger(stc = 100, cbtc = 50, ceth = 50) {
    const chain = newFreshChain(), alice = generateWallet();
    const evaluation = chain.evaluateChain();
    for (const [currency, amount] of Object.entries({ STC: stc, cBTC: cbtc, cETH: ceth })) {
        evaluation.state.balances.set(alice.address + ':' + currency, toUnits(amount));
    }
    return { chain, alice, evaluation };
}

describe('共识账本中的多币种余额和 STC 手续费', () => {
    // Seed a ledger state to test the transfer engine. This is not a token minting
    // mechanism: production blocks cannot create cBTC/cETH through SYSTEM.
    it.each([
        ['STC', 95, 5, 100, 50, true], ['STC', 96, 5, 100, 50, false],
        ['STC', 100, 0, 100, 50, true], ['STC', 1, 200, 100, 50, false],
        ['cBTC', 10, 2, 100, 50, true], ['cBTC', 51, 2, 100, 50, false],
        ['cBTC', 10, 2, 1, 50, false], ['cBTC', 10, 0, 0, 50, true],
        ['cETH', 10, 2, 100, 50, true], ['cETH', 51, 2, 100, 50, false]
    ])('%s amount=%s fee=%s STC=%s token=%s accepted=%s', (currency, amount, fee, stc, token, accepted) => {
        const { chain, alice, evaluation } = ledger(stc, token, token);
        const tx = createSignedTx(alice, 'bob', amount, fee, '', currency);
        const pool = chain.consensus.rebuildPool(evaluation, [tx]);
        expect(pool.pending.length === 1).toBe(accepted);
    });
    it('连续 STC 转账累计扣除 amount 和 fee', () => {
        const { chain, alice, evaluation } = ledger();
        const a = createSignedTx(alice, 'bob', 60, 5), b = createSignedTx(alice, 'charlie', 40, 0, '', 'STC', 1);
        const pool = chain.consensus.rebuildPool(evaluation, [a, b]);
        expect(pool.pending.map(tx => tx.id)).toEqual([a.id]);
        expect(pool.rejected[0].error).toMatch(/余额不足/);
    });
    it('代币余额和所有币种的 STC fee 独立累计', () => {
        const { chain, alice, evaluation } = ledger(5, 20, 20);
        const a = createSignedTx(alice, 'bob', 10, 3, '', 'cBTC');
        const b = createSignedTx(alice, 'charlie', 10, 3, '', 'cETH', 1);
        expect(chain.consensus.rebuildPool(evaluation, [a, b]).pending.map(tx => tx.id)).toEqual([a.id]);
    });
    it('待确认收款不能成为交易池可用资金', () => {
        const { chain, alice, evaluation } = ledger();
        const bob = generateWallet();
        const a = createSignedTx(alice, bob.address, 10);
        const b = createSignedTx(bob, 'charlie', 10);
        expect(chain.consensus.rebuildPool(evaluation, [a, b]).pending.map(tx => tx.id)).toEqual([a.id]);
    });
    it('同一地址不同币种仍共用 nonce', () => {
        const { chain, alice, evaluation } = ledger();
        const a = createSignedTx(alice, 'bob', 1, 0, '', 'cBTC');
        const b = createSignedTx(alice, 'charlie', 1, 0, '', 'cETH');
        expect(chain.consensus.rebuildPool(evaluation, [a, b]).pending).toHaveLength(1);
    });
    it.each(['WBTC', 'unknown', '', null])('v2 拒绝非规范币种 %s', currency => {
        const { chain, alice, evaluation } = ledger();
        const tx = chain.createTransaction(alice.address, 'bob', 1, 0, '', currency, 0);
        tx.signTransaction(alice.privateKey, alice.publicKey);
        expect(chain.consensus.rebuildPool(evaluation, [tx]).pending).toHaveLength(0);
    });
    it('网络没有无授权代币铸币入口', () => {
        const chain = newFreshChain(), { block } = chain.buildCandidate('miner');
        block.transactions[0].currency = 'cBTC';
        block.transactions[0].id = block.transactions[0].calculateHash();
        block.updateMerkleRoot(); block.hash = block.calculateHash(); block.mineBlock(chain.difficulty);
        expect(chain.addBlock(block)).toBeNull();
    });
});
