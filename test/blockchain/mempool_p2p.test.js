// ============================================================
// P2P 交易池广播 — 单元测试
// 覆盖: 交易池去重、P2P 交易接收、区块确认清理、链替换清理
// ============================================================
const { Block, Transaction, generateWallet } = require('../../src/blockchain/blockchain');
const { newFreshChain, createSignedTx } = require('../helpers');

// ============================================================
// 辅助：给链添加一个包含挖矿奖励的区块
// ============================================================
function mineRewardBlock(chain, address, amount = 100) {
  const rewardTx = new Transaction('SYSTEM', address, amount, 0, 'Test Reward');
  const prevBlock = chain.getLatestBlock();
  const block = new Block(prevBlock.index + 1, new Date().toISOString(), [rewardTx], prevBlock.hash);
  block.mineBlock(chain.difficulty);
  chain.chain.push(block);
}

// ============================================================
// 第1组: hasPendingTransaction() — 去重检查
// ============================================================
describe('hasPendingTransaction() — 交易池去重', () => {
  let walletA, walletB;

  beforeAll(() => {
    walletA = generateWallet();
    walletB = generateWallet();
  });

  it('空交易池中查询任意 ID 返回 false', () => {
    const chain = newFreshChain();
    expect(chain.hasPendingTransaction('nonexistent-id-12345')).toBe(false);
  });

  it('交易存在时 hasPendingTransaction 返回 true', () => {
    const chain = newFreshChain();
    const tx = createSignedTx(walletA, walletB.address, 10, 1);
    chain.pendingTransactions.push(tx);
    expect(chain.hasPendingTransaction(tx.id)).toBe(true);
  });

  it('交易不存在时 hasPendingTransaction 返回 false', () => {
    const chain = newFreshChain();
    const tx1 = createSignedTx(walletA, walletB.address, 10, 1);
    const tx2 = createSignedTx(walletA, walletB.address, 20, 1);
    chain.pendingTransactions.push(tx1);
    expect(chain.hasPendingTransaction(tx2.id)).toBe(false);
  });

  it('交易池有多个交易时仍能准确查找', () => {
    const chain = newFreshChain();
    const txs = [
      createSignedTx(walletA, walletB.address, 10, 1),
      createSignedTx(walletB, walletA.address, 5, 1),
      createSignedTx(walletA, walletB.address, 3, 1),
    ];
    txs.forEach(t => chain.pendingTransactions.push(t));
    expect(txs.every(t => chain.hasPendingTransaction(t.id))).toBe(true);
    expect(chain.hasPendingTransaction('bogus-id')).toBe(false);
  });
});

// ============================================================
// 第2组: addPendingTransaction() — P2P 交易接收
// ============================================================
describe('addPendingTransaction() — P2P 交易接收', () => {
  let walletA, walletB;

  beforeAll(() => {
    walletA = generateWallet();
    walletB = generateWallet();
  });

  it('跳过余额检查：接收有效的签名交易', () => {
    const chain = newFreshChain();
    const tx = createSignedTx(walletA, walletB.address, 99999, 1, '大额P2P测试');
    const result = chain.addPendingTransaction(tx, true);
    expect(result.success).toBe(true);
    expect(result.transaction.id).toBe(tx.id);
  });

  it('跳过余额检查：SYSTEM 奖励交易可以直接接收', () => {
    const chain = newFreshChain();
    const rewardTx = new Transaction('SYSTEM', walletA.address, 50, 0, 'Mining Reward');
    const result = chain.addPendingTransaction(rewardTx, true);
    expect(result.success).toBe(true);
  });

  it('不跳过余额检查：余额充足时成功', () => {
    const chain = newFreshChain();
    mineRewardBlock(chain, walletA.address, 100);
    const tx = createSignedTx(walletA, walletB.address, 30, 2);
    const result = chain.addPendingTransaction(tx, false);
    expect(result.success).toBe(true);
  });

  it('不跳过余额检查：余额不足时失败', () => {
    const chain = newFreshChain();
    const tx = createSignedTx(walletA, walletB.address, 30, 2);
    const result = chain.addPendingTransaction(tx, false);
    expect(result.success).toBe(false);
    expect(result.error).toContain('余额不足');
  });

  it('重复交易 ID 被拒绝（去重保护）', () => {
    const chain = newFreshChain();
    const tx = createSignedTx(walletA, walletB.address, 10, 1);
    const first = chain.addPendingTransaction(tx, true);
    const second = chain.addPendingTransaction(tx, true);
    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(second.error).toContain('已存在于交易池');
  });

  it('同一笔交易数据（相同 ID）重复添加被拒绝', () => {
    const chain = newFreshChain();
    const tx1 = createSignedTx(walletA, walletB.address, 10, 1);
    const first = chain.addPendingTransaction(tx1, true);

    const tx2 = new Transaction(walletA.address, walletB.address, 10, 1);
    tx2.signature = tx1.signature;
    tx2.publicKey = tx1.publicKey;
    tx2.timestamp = tx1.timestamp;
    tx2.id = tx1.id;

    const second = chain.addPendingTransaction(tx2, true);
    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(chain.pendingTransactions.length).toBe(1);
  });

  it('无效签名交易被拒绝', () => {
    const chain = newFreshChain();
    const tx = new Transaction(walletA.address, walletB.address, 10, 1, '未签名测试');
    const result = chain.addPendingTransaction(tx, true);
    expect(result.success).toBe(false);
    expect(result.error).toContain('签名验证失败');
  });

  it('假冒签名（A 的私钥 + B 的公钥）的交易被拒绝', () => {
    const chain = newFreshChain();
    const tx = new Transaction(walletA.address, walletB.address, 10, 1);
    expect(() => {
      tx.signTransaction(walletA.privateKey, walletB.publicKey);
    }).toThrow();

    const result = chain.addPendingTransaction(tx, true);
    expect(result.success).toBe(false);
  });

  it('缺少 from 字段被拒绝', () => {
    const chain = newFreshChain();
    const tx = new Transaction('', walletB.address, 10, 1, '无发送方');
    const result = chain.addPendingTransaction(tx, true);
    expect(result.success).toBe(false);
    expect(result.error).toContain('缺少必要字段');
  });

  it('给自己转账被拒绝', () => {
    const chain = newFreshChain();
    const tx = createSignedTx(walletA, walletA.address, 10, 1, '自转账');
    const result = chain.addPendingTransaction(tx, true);
    expect(result.success).toBe(false);
    expect(result.error).toContain('不能给自己转账');
  });

  it('金额为零被拒绝', () => {
    const chain = newFreshChain();
    const tx = createSignedTx(walletA, walletB.address, 0, 1, '零金额');
    const result = chain.addPendingTransaction(tx, true);
    expect(result.success).toBe(false);
    expect(result.error).toContain('缺少必要字段');
  });

  it('金额为负数被拒绝', () => {
    const chain = newFreshChain();
    const tx = createSignedTx(walletA, walletB.address, -5, 1, '负金额');
    const result = chain.addPendingTransaction(tx, true);
    expect(result.success).toBe(false);
  });

  it('P2P 接收的交易加入交易池后，池大小正确增加', () => {
    const chain = newFreshChain();
    const txs = [
      createSignedTx(walletA, walletB.address, 10, 1),
      createSignedTx(walletB, walletA.address, 5, 1),
    ];

    const rawTx1 = {
      id: txs[0].id,
      from: txs[0].from,
      to: txs[0].to,
      amount: txs[0].amount,
      fee: txs[0].fee,
      note: txs[0].note,
      timestamp: txs[0].timestamp,
      signature: txs[0].signature,
      publicKey: txs[0].publicKey,
    };
    const rawTx2 = {
      id: txs[1].id,
      from: txs[1].from,
      to: txs[1].to,
      amount: txs[1].amount,
      fee: txs[1].fee,
      note: txs[1].note,
      timestamp: txs[1].timestamp,
      signature: txs[1].signature,
      publicKey: txs[1].publicKey,
    };

    const r1 = chain.addPendingTransaction(rawTx1, true);
    const r2 = chain.addPendingTransaction(rawTx2, true);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(chain.pendingTransactions.length).toBe(2);
  });
});

// ============================================================
// 第3组: addBlock() — 区块确认后交易池清理
// ============================================================
describe('addBlock() — 区块确认后交易池清理', () => {
  let walletA, walletB;

  beforeAll(() => {
    walletA = generateWallet();
    walletB = generateWallet();
  });

  it('添加含交易的区块后，交易池中该交易被移除', () => {
    const chain = newFreshChain();
    mineRewardBlock(chain, walletA.address, 100);

    const tx = createSignedTx(walletA, walletB.address, 30, 2);
    chain.pendingTransactions.push(tx);
    chain.pendingTransactions.push(
      createSignedTx(walletA, walletB.address, 5, 1),
    );

    const before = chain.pendingTransactions.length;

    const rewardTx = new Transaction('SYSTEM', walletA.address, 50, 0, 'Mining Reward');
    const newBlock = new Block(
      chain.getLatestBlock().index + 1,
      new Date().toISOString(),
      [rewardTx, tx],
      chain.getLatestBlock().hash,
    );
    newBlock.mineBlock(chain.difficulty);
    chain.addBlock(newBlock);

    expect(chain.hasPendingTransaction(tx.id)).toBe(false);
    expect(chain.pendingTransactions.length).toBe(before - 1);
  });

  it('添加不含已知交易的区块，交易池不变', () => {
    const chain = newFreshChain();
    mineRewardBlock(chain, walletA.address, 100);

    const tx1 = createSignedTx(walletA, walletB.address, 10, 1);
    const tx2 = createSignedTx(walletA, walletB.address, 20, 1);
    chain.pendingTransactions.push(tx1, tx2);

    const before = chain.pendingTransactions.length;

    const rewardTx = new Transaction('SYSTEM', walletA.address, 50, 0, 'Mining Reward');
    const newBlock = new Block(
      chain.getLatestBlock().index + 1,
      new Date().toISOString(),
      [rewardTx],
      chain.getLatestBlock().hash,
    );
    newBlock.mineBlock(chain.difficulty);
    chain.addBlock(newBlock);

    expect(chain.pendingTransactions.length).toBe(before);
    expect(chain.hasPendingTransaction(tx1.id)).toBe(true);
    expect(chain.hasPendingTransaction(tx2.id)).toBe(true);
  });
});

// ============================================================
// 第4组: chain.replaceChain() — 链替换时交易池清理
// ============================================================
describe('chain.replaceChain() — 链替换时交易池清理', () => {
  let walletA, walletB;

  beforeAll(() => {
    walletA = generateWallet();
    walletB = generateWallet();
  });

  it('替换链后，新链中的交易从交易池移除', () => {
    const chain = newFreshChain();
    const otherChain = newFreshChain();

    mineRewardBlock(chain, walletA.address, 100);
    mineRewardBlock(otherChain, walletA.address, 100);

    const tx = createSignedTx(walletA, walletB.address, 30, 2);
    chain.pendingTransactions.push(tx);
    chain.pendingTransactions.push(
      createSignedTx(walletA, walletB.address, 5, 1),
    );

    const txCountBefore = chain.pendingTransactions.length;

    // 另一个链打包了 tx
    const rewardTx = new Transaction('SYSTEM', walletA.address, 50, 0, 'Mining Reward');
    const blockForOther = new Block(
      otherChain.getLatestBlock().index + 1,
      new Date().toISOString(),
      [rewardTx, tx],
      otherChain.getLatestBlock().hash,
    );
    blockForOther.mineBlock(otherChain.difficulty);
    otherChain.chain.push(blockForOther);

    // 替换链
    chain.replaceChain(otherChain.chain);

    expect(chain.hasPendingTransaction(tx.id)).toBe(false);
    expect(chain.pendingTransactions.length).toBe(txCountBefore - 1);
  });

  it('替换链后，旧链独有的交易应回到交易池', () => {
    const chain = newFreshChain();
    const otherChain = newFreshChain();

    mineRewardBlock(chain, walletA.address, 100);
    mineRewardBlock(otherChain, walletA.address, 100);

    const tx = createSignedTx(walletA, walletB.address, 30, 2);
    chain.pendingTransactions.push(tx);

    // 在 chain 上挖一个包含 tx 的区块
    const rewardTx = new Transaction('SYSTEM', walletA.address, 50, 0, 'Mining Reward');
    const blockWithTx = new Block(
      chain.getLatestBlock().index + 1,
      new Date().toISOString(),
      [rewardTx, tx],
      chain.getLatestBlock().hash,
    );
    blockWithTx.mineBlock(chain.difficulty);
    chain.addBlock(blockWithTx);

    // 现在 tx 从交易池移除（已被打包）
    expect(chain.hasPendingTransaction(tx.id)).toBe(false);

    // otherChain 更长但没有 tx，替换后 tx 应该回到交易池
    const emptyBlock1 = new Block(
      otherChain.getLatestBlock().index + 1,
      new Date().toISOString(),
      [new Transaction('SYSTEM', walletA.address, 50, 0, 'Mining Reward')],
      otherChain.getLatestBlock().hash,
    );
    emptyBlock1.mineBlock(otherChain.difficulty);
    otherChain.chain.push(emptyBlock1);

    const emptyBlock2 = new Block(
      otherChain.getLatestBlock().index + 1,
      new Date().toISOString(),
      [new Transaction('SYSTEM', walletA.address, 50, 0, 'Mining Reward')],
      otherChain.getLatestBlock().hash,
    );
    emptyBlock2.mineBlock(otherChain.difficulty);
    otherChain.chain.push(emptyBlock2);

    // otherChain.chain 现在有 3 个区块（创世 + 2），比 chain（创世 + 2）... 实际上一样长
    // 需要 otherChain 严格更长
    const emptyBlock3 = new Block(
      otherChain.getLatestBlock().index + 1,
      new Date().toISOString(),
      [new Transaction('SYSTEM', walletA.address, 50, 0, 'Mining Reward')],
      otherChain.getLatestBlock().hash,
    );
    emptyBlock3.mineBlock(otherChain.difficulty);
    otherChain.chain.push(emptyBlock3);

    chain.replaceChain(otherChain.chain);

    // tx 应该回到交易池（因为新链不包含它）
    expect(chain.hasPendingTransaction(tx.id)).toBe(true);
  });
});