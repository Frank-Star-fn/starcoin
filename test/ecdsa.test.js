// ============================================================
// ECDSA 签名系统测试
// ============================================================
const crypto = require('crypto');
const { Blockchain, Block, Transaction, generateWallet, importWalletFromPem } = require('../src/blockchain/blockchain');
const { newFreshChain } = require('./helpers');

// ============================================================
// 第1组: 钱包生成测试
// ============================================================
describe('钱包生成', () => {
  let walletA, walletB;

  it('generateWallet() 能生成包含 privateKey/publicKey/address 的对象', () => {
    const w = generateWallet();
    expect(w.privateKey).toBeTruthy();
    expect(w.publicKey).toBeTruthy();
    expect(w.address).toBeTruthy();
  });

  it('私钥是 PEM 格式（以 "-----BEGIN" 开头）', () => {
    const w = generateWallet();
    expect(w.privateKey.startsWith('-----BEGIN')).toBe(true);
  });

  it('公钥是十六进制字符串（DER 编码）', () => {
    const w = generateWallet();
    expect(w.publicKey).toMatch(/^[0-9a-fA-F]+$/);
  });

  it('地址是公钥 SHA256 的前 32 个十六进制字符', () => {
    const w = generateWallet();
    const expectedAddr = crypto.createHash('sha256').update(w.publicKey, 'hex').digest('hex').substring(0, 32);
    expect(w.address).toBe(expectedAddr);
  });

  it('两个不同钱包的 address 不同', () => {
    walletA = generateWallet();
    walletB = generateWallet();
    expect(walletA.address).not.toBe(walletB.address);
  });
});

// ============================================================
// 第2组: ECDSA 签名测试
// ============================================================
describe('ECDSA 签名', () => {
  let walletA, walletB;

  beforeAll(() => {
    walletA = generateWallet();
    walletB = generateWallet();
  });

  it('普通交易能用正确的 privateKey/publicKey 签名', () => {
    const tx = new Transaction(walletA.address, walletB.address, 10, 1, '测试交易');
    tx.signTransaction(walletA.privateKey, walletA.publicKey);
    expect(tx.signature).toBeTruthy();
    expect(tx.signature.length).toBeGreaterThan(20);
    expect(tx.publicKey).toBe(walletA.publicKey);
  });

  it('已签名交易的 isValid() 返回 true', () => {
    const tx = new Transaction(walletA.address, walletB.address, 10, 1, '测试交易');
    tx.signTransaction(walletA.privateKey, walletA.publicKey);
    expect(tx.isValid()).toBe(true);
  });

  it('未签名交易的 isValid() 返回 false', () => {
    const tx = new Transaction(walletA.address, walletB.address, 10, 1, '未签名测试');
    expect(tx.isValid()).toBe(false);
  });

  it('挖矿奖励交易（from=SYSTEM）无需签名，isValid() 返回 true', () => {
    const rewardTx = new Transaction('SYSTEM', walletB.address, 50, 0, 'Miner Reward');
    expect(rewardTx.isValid()).toBe(true);
  });

  it('备注交易（from 为空）无需签名，isValid() 返回 true', () => {
    const noteTx = new Transaction('', 'NOTE', 0, 0, '备注测试');
    expect(noteTx.isValid()).toBe(true);
  });
});

// ============================================================
// 第3组: 安全测试 —— 防止冒名签名
// ============================================================
describe('安全测试 —— 防止冒名签名', () => {
  let walletA, walletB;

  beforeAll(() => {
    walletA = generateWallet();
    walletB = generateWallet();
  });

  it('用 A 的私钥但 B 的公钥签名应失败', () => {
    const tx = new Transaction(walletA.address, walletB.address, 10);
    expect(() => {
      tx.signTransaction(walletA.privateKey, walletB.publicKey);
    }).toThrow();
  });

  it('篡改 amount 后签名失效', () => {
    const tx = new Transaction(walletA.address, walletB.address, 10);
    tx.signTransaction(walletA.privateKey, walletA.publicKey);
    expect(tx.isValid()).toBe(true);
    tx.amount = 999;
    expect(tx.isValid()).toBe(false);
  });

  it('篡改 from 后签名失效', () => {
    const tx = new Transaction(walletA.address, walletB.address, 10);
    tx.signTransaction(walletA.privateKey, walletA.publicKey);
    tx.from = walletB.address;
    expect(tx.isValid()).toBe(false);
  });

  it('替换 signature 后验证失败', () => {
    const tx = new Transaction(walletA.address, walletB.address, 10);
    tx.signTransaction(walletA.privateKey, walletA.publicKey);
    tx.signature = 'a'.repeat(64);
    expect(tx.isValid()).toBe(false);
  });
});

// ============================================================
// 第4组: Blockchain 集成测试
// ============================================================
describe('Blockchain 集成', () => {
  let walletA, walletB;

  beforeAll(() => {
    walletA = generateWallet();
    walletB = generateWallet();
  });

  it('addTransaction 接受已正确签名的交易', () => {
    const chain = newFreshChain();
    const tx = new Transaction(walletA.address, walletB.address, 10, 1, '集成测试');
    tx.signTransaction(walletA.privateKey, walletA.publicKey);
    // 先给 walletA 发一笔挖矿奖励让它有钱
    chain.chain.push(new Block(1, new Date().toISOString(),
      [new Transaction('SYSTEM', walletA.address, 100, 0, 'Initial Coin')],
      chain.chain[0].hash,
    ));
    chain.chain[1].mineBlock(chain.difficulty);
    const saved = chain.addTransaction(tx);
    expect(saved).toBeTruthy();
  });

  it('addTransaction 拒绝未签名的普通交易', () => {
    const chain = newFreshChain();
    chain.chain.push(new Block(1, new Date().toISOString(),
      [new Transaction('SYSTEM', walletA.address, 100, 0, 'Initial Coin')],
      chain.chain[0].hash,
    ));
    chain.chain[1].mineBlock(chain.difficulty);
    const tx = new Transaction(walletA.address, walletB.address, 10);
    expect(() => chain.addTransaction(tx)).toThrow();
  });
});

// ============================================================
// 第5组: 完整流程测试
// ============================================================
describe('完整流程: 转账 → 挖矿 → 验证', () => {
  it('完整流程: 生成钱包 → 获得奖励 → 转账 → 挖矿 → 链有效', () => {
    const chain = newFreshChain();
    const alice = generateWallet();
    const bob = generateWallet();

    // 区块 1: 给 Alice 100 币
    const rewardTx1 = new Transaction('SYSTEM', alice.address, 100, 0, 'Mining Reward');
    const block1 = new Block(1, new Date().toISOString(), [rewardTx1], chain.chain[0].hash);
    block1.mineBlock(chain.difficulty);
    chain.chain.push(block1);

    // Alice 给 Bob 转 30 币
    const transferTx = new Transaction(alice.address, bob.address, 30, 2, '转账测试');
    transferTx.signTransaction(alice.privateKey, alice.publicKey);
    expect(transferTx.isValid()).toBe(true);
    chain.pendingTransactions.push(transferTx);

    // 区块 2: 打包转账交易 + 新奖励
    const rewardTx2 = new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward');
    const block2 = new Block(2, new Date().toISOString(),
      [rewardTx2, transferTx], chain.chain[1].hash);
    block2.mineBlock(chain.difficulty);
    chain.chain.push(block2);

    const valid = chain.isChainValid();
    const aliceBal = chain.getBalance(alice.address);
    const bobBal = chain.getBalance(bob.address);

    expect(valid).toBe(true);
    expect(aliceBal).toBe(118);
    expect(bobBal).toBe(30);
  });

  it('篡改链上交易后 isChainValid 返回 false', () => {
    const chain = newFreshChain();
    const alice = generateWallet();

    const rewardTx = new Transaction('SYSTEM', alice.address, 100, 0, 'Mining Reward');
    const block1 = new Block(1, new Date().toISOString(), [rewardTx], chain.chain[0].hash);
    block1.mineBlock(chain.difficulty);
    chain.chain.push(block1);

    const before = chain.isChainValid();
    expect(before).toBe(true);

    const tx = new Transaction(alice.address, 'attacker', 20);
    tx.signTransaction(alice.privateKey, alice.publicKey);
    chain.pendingTransactions.push(tx);
    const rewardTx2 = new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward');
    const block2 = new Block(2, new Date().toISOString(),
      [rewardTx2, tx], chain.chain[1].hash);
    block2.mineBlock(chain.difficulty);
    chain.chain.push(block2);

    // 故意篡改
    chain.chain[2].transactions[1].amount = 999999;

    expect(chain.isChainValid()).toBe(false);
  });
});

// ============================================================
// 第6组: 私钥导入/导出测试
// ============================================================
describe('私钥导入/导出', () => {
  let originalWallet;

  it('importWalletFromPem 可以导入 generateWallet 生成的 PEM 私钥', () => {
    const w1 = generateWallet();
    originalWallet = w1;
    const imported = importWalletFromPem(w1.privateKey);
    expect(imported.privateKey).toBe(w1.privateKey);
    expect(imported.publicKey).toBe(w1.publicKey);
    expect(imported.address).toBe(w1.address);
  });

  it('importWalletFromPem 返回的 address 与原始钱包一致', () => {
    const expectedAddr = crypto.createHash('sha256')
      .update(originalWallet.publicKey, 'hex').digest('hex').substring(0, 32);
    const imported = importWalletFromPem(originalWallet.privateKey);
    expect(imported.address).toBe(expectedAddr);
  });

  it('用导入的私钥能正常签名交易', () => {
    const w2 = generateWallet();
    const imported = importWalletFromPem(w2.privateKey);
    const tx = new Transaction(imported.address, w2.address, 5, 1, '导入密钥签名测试');
    tx.signTransaction(imported.privateKey, imported.publicKey);
    expect(tx.isValid()).toBe(true);
  });

  it('importWalletFromPem 拒绝无效的 PEM 字符串', () => {
    expect(() => importWalletFromPem('这不是有效的 PEM 格式')).toThrow();
  });

  it('importWalletFromPem 拒绝空字符串', () => {
    expect(() => importWalletFromPem('')).toThrow();
  });

  it('生成 → 导出 PEM → 重新导入 → 地址一致（完整流程）', () => {
    const alice = generateWallet();
    const pem = alice.privateKey;
    const imported = importWalletFromPem(pem);

    const tx = new Transaction(imported.address, alice.address, 10, 0, '完整流程测试');
    tx.signTransaction(imported.privateKey, imported.publicKey);

    expect(imported.address).toBe(alice.address);
    expect(imported.publicKey).toBe(alice.publicKey);
    expect(tx.isValid()).toBe(true);
  });
});