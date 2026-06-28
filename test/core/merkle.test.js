// ============================================================
// Merkle 树单元测试
// ============================================================
const crypto = require('crypto');
const { Block, Transaction, calculateMerkleRoot } = require('../../src/core');

// ============================================================
// 辅助：创建确定性 Transaction（覆盖随机 id/timestamp）
// ============================================================
function createDeterministicTx(from, to, amount, fee = 0, note = '', seed = '') {
  const tx = new Transaction(from, to, amount, fee, note);
  tx.id = crypto.createHash('sha256')
    .update(`tx:${from}:${to}:${amount}:${fee}:${note}:${seed}`)
    .digest('hex');
  tx.timestamp = '2025-01-01T00:00:00.000Z';
  return tx;
}

// ============================================================
// 辅助：创建确定性 JSON 交易对象
// ============================================================
function createDeterministicJsonTx(from, to, amount, fee = 0, note = '', seed = '') {
  const id = crypto.createHash('sha256')
    .update(`tx:${from}:${to}:${amount}:${fee}:${note}:${seed}`)
    .digest('hex');
  return {
    id,
    from,
    to,
    amount,
    fee,
    note,
    timestamp: '2025-01-01T00:00:00.000Z',
  };
}

const EMPTY_MERKLE_ROOT = crypto.createHash('sha256').update('').digest('hex');

// ============================================================
// 第1组: calculateMerkleRoot 基础测试
// ============================================================
describe('calculateMerkleRoot 基础', () => {
  it('空交易列表返回 sha256("") 的确定性值', () => {
    expect(calculateMerkleRoot([])).toBe(EMPTY_MERKLE_ROOT);
  });

  it('null/undefined 也返回 sha256("")', () => {
    expect(calculateMerkleRoot(null)).toBe(EMPTY_MERKLE_ROOT);
    expect(calculateMerkleRoot(undefined)).toBe(EMPTY_MERKLE_ROOT);
  });

  it('单笔交易返回该交易的 calculateHash() 值', () => {
    const tx = createDeterministicTx('Alice', 'Bob', 100, 1, '付款');
    expect(calculateMerkleRoot([tx])).toBe(tx.calculateHash());
  });

  it('两笔交易: Merkle 根 = hash(hash(tx1) + hash(tx2))', () => {
    const tx1 = createDeterministicTx('Alice', 'Bob', 100, 0, '', '1');
    const tx2 = createDeterministicTx('Bob', 'Charlie', 50, 0, '', '2');
    const root = calculateMerkleRoot([tx1, tx2]);

    const h1 = tx1.calculateHash();
    const h2 = tx2.calculateHash();
    const expected = crypto.createHash('sha256').update(h1 + h2).digest('hex');
    expect(root).toBe(expected);
  });

  it('三笔交易（奇数）: 复制第三笔凑偶 → 四笔', () => {
    const tx1 = createDeterministicTx('A', 'B', 10, 0, '', '1');
    const tx2 = createDeterministicTx('B', 'C', 20, 0, '', '2');
    const tx3 = createDeterministicTx('C', 'D', 30, 0, '', '3');
    const root = calculateMerkleRoot([tx1, tx2, tx3]);

    const h1 = tx1.calculateHash();
    const h2 = tx2.calculateHash();
    const h3 = tx3.calculateHash();
    const h12 = crypto.createHash('sha256').update(h1 + h2).digest('hex');
    const h33 = crypto.createHash('sha256').update(h3 + h3).digest('hex');
    const expected = crypto.createHash('sha256').update(h12 + h33).digest('hex');
    expect(root).toBe(expected);
  });

  it('四笔交易: 标准二叉树结构', () => {
    const txs = [1, 2, 3, 4].map(i =>
      createDeterministicTx('A', 'B', i * 10, 0, '', String(i)),
    );
    const root = calculateMerkleRoot(txs);

    const hs = txs.map(tx => tx.calculateHash());
    const h12 = crypto.createHash('sha256').update(hs[0] + hs[1]).digest('hex');
    const h34 = crypto.createHash('sha256').update(hs[2] + hs[3]).digest('hex');
    const expected = crypto.createHash('sha256').update(h12 + h34).digest('hex');
    expect(root).toBe(expected);
  });
});

// ============================================================
// 第2组: 确定性测试
// ============================================================
describe('确定性测试 — 相同输入 = 相同输出', () => {
  it('相同输入两次调用结果一致', () => {
    const txs = [
      createDeterministicTx('A', 'B', 10, 0, '', '1'),
      createDeterministicTx('C', 'D', 20, 0, '', '2'),
    ];
    expect(calculateMerkleRoot(txs)).toBe(calculateMerkleRoot(txs));
  });

  it('不同输入产生不同的 Merkle 根', () => {
    const txs1 = [createDeterministicTx('A', 'B', 10, 0, '', '1')];
    const txs2 = [createDeterministicTx('A', 'B', 20, 0, '', '2')];
    expect(calculateMerkleRoot(txs1)).not.toBe(calculateMerkleRoot(txs2));
  });

  it('交易顺序影响 Merkle 根', () => {
    const txA = createDeterministicTx('A', 'B', 10, 0, '', '1');
    const txB = createDeterministicTx('C', 'D', 20, 0, '', '2');
    expect(calculateMerkleRoot([txA, txB])).not.toBe(calculateMerkleRoot([txB, txA]));
  });
});

// ============================================================
// 第3组: JSON 对象兼容性
// ============================================================
describe('普通 JSON 对象兼容性', () => {
  it('普通 JSON 对象（无 calculateHash 方法）也能计算 Merkle 根', () => {
    const tx1 = createDeterministicJsonTx('A', 'B', 10, 0, 'test', '1');
    const root = calculateMerkleRoot([tx1]);
    expect(root).toMatch(/^[0-9a-f]{64}$/);
  });

  it('Transaction 实例与 JSON 对象内容相同时 Merkle 根一致', () => {
    const seed = 'same-content';
    const txInstance = createDeterministicTx('X', 'Y', 99, 1, '测试', seed);
    const txJson = createDeterministicJsonTx('X', 'Y', 99, 1, '测试', seed);

    expect(calculateMerkleRoot([txInstance])).toBe(calculateMerkleRoot([txJson]));
  });

  it('混合 Transaction 实例和 JSON 对象也能正确计算', () => {
    const tx1 = createDeterministicTx('A', 'B', 10, 0, '', '1');
    const tx2 = createDeterministicJsonTx('C', 'D', 20, 0, '', '2');
    const root = calculateMerkleRoot([tx1, tx2]);
    expect(root).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ============================================================
// 第4组: Block 集成
// ============================================================
describe('Block 集成 — Merkle 根自动计算', () => {
  it('Block 构造后自动计算 merkleRoot', () => {
    const txs = [
      createDeterministicTx('Alice', 'Bob', 100, 0, '付款', '1'),
      createDeterministicTx('Bob', 'Charlie', 50, 0, '找零', '2'),
    ];
    const block = new Block(1, '2025-01-01T00:00:00.000Z', txs, '0'.repeat(64));
    expect(block.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
  });

  it('Block 的 merkleRoot 等于 calculateMerkleRoot(transactions)', () => {
    const txs = [
      createDeterministicTx('A', 'B', 10, 0, '', '1'),
      createDeterministicTx('C', 'D', 20, 0, '', '2'),
    ];
    const block = new Block(1, '2025-01-01T00:00:00.000Z', txs, '0'.repeat(64));
    expect(block.merkleRoot).toBe(calculateMerkleRoot(txs));
  });

  it('updateMerkleRoot 能重新计算', () => {
    const txs = [createDeterministicTx('A', 'B', 10, 0, '', '1')];
    const block = new Block(1, '2025-01-01T00:00:00.000Z', txs, '0'.repeat(64));
    const originalRoot = block.merkleRoot;

    const newTx = createDeterministicTx('C', 'D', 20, 0, '', '2');
    block.transactions.push(newTx);
    block.updateMerkleRoot();

    expect(block.merkleRoot).not.toBe(originalRoot);
    expect(block.merkleRoot).toBe(calculateMerkleRoot(block.transactions));
  });
});

// ============================================================
// 第5组: 篡改检测
// ============================================================
describe('篡改检测 — Merkle 根变化', () => {
  it('篡改交易金额后 Merkle 根变化', () => {
    const tx = createDeterministicTx('Alice', 'Bob', 100, 0, '', '1');
    const originalRoot = calculateMerkleRoot([tx]);

    tx.amount = 999;
    expect(calculateMerkleRoot([tx])).not.toBe(originalRoot);
  });

  it('篡改交易备注后 Merkle 根变化', () => {
    const tx = createDeterministicTx('Alice', 'Bob', 100, 0, '原始备注', '1');
    const originalRoot = calculateMerkleRoot([tx]);

    tx.note = '篡改后的备注';
    expect(calculateMerkleRoot([tx])).not.toBe(originalRoot);
  });

  it('区块中任意交易被篡改 → block hash 变化（通过 Merkle 根传导）', () => {
    const txs = [
      createDeterministicTx('A', 'B', 50, 0, '', '1'),
      createDeterministicTx('C', 'D', 30, 0, '', '2'),
    ];
    const block = new Block(1, '2025-01-01T00:00:00.000Z', txs, '0'.repeat(64));
    const originalHash = block.hash;

    block.transactions[1].amount = 999999;
    block.updateMerkleRoot();
    const newHash = block.calculateHash();

    expect(newHash).not.toBe(originalHash);
  });
});