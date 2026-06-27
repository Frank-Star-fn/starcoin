// ============================================================
// addTransaction 边界条件单元测试
// ============================================================
const { Transaction, generateWallet } = require('../src/blockchain');
const { newFreshChain, fundAddress, createSignedTx } = require('./helpers');

// ============================================================
// 第1组: 基本参数校验
// ============================================================
describe('基本参数校验', () => {
  it('from 为空时抛出 "必须包含 from"', () => {
    const chain = newFreshChain();
    const tx = new Transaction('', 'addr1', 10);
    expect(() => chain.addTransaction(tx)).toThrow(/必须包含 from/);
  });

  it('from 为 undefined 时抛出错误', () => {
    const chain = newFreshChain();
    const tx = new Transaction(undefined, 'addr1', 10);
    expect(() => chain.addTransaction(tx)).toThrow(/必须包含 from/);
  });

  it('from 为 null 时抛出错误', () => {
    const chain = newFreshChain();
    const tx = new Transaction(null, 'addr1', 10);
    expect(() => chain.addTransaction(tx)).toThrow();
  });

  it('to 为空时抛出 "必须包含 from"', () => {
    const chain = newFreshChain();
    const tx = new Transaction('addr1', '', 10);
    expect(() => chain.addTransaction(tx)).toThrow(/必须包含 from/);
  });

  it('to 为 null 时抛出错误', () => {
    const chain = newFreshChain();
    const tx = new Transaction('addr1', null, 10);
    expect(() => chain.addTransaction(tx)).toThrow();
  });

  it('amount = 0 时抛出 "必须包含 from"', () => {
    const chain = newFreshChain();
    const tx = new Transaction('addr1', 'addr2', 0);
    expect(() => chain.addTransaction(tx)).toThrow(/必须包含 from/);
  });

  it('amount 为负数（-10）时抛出错误', () => {
    const chain = newFreshChain();
    const tx = new Transaction('addr1', 'addr2', -10);
    expect(() => chain.addTransaction(tx)).toThrow();
  });

  it('amount 为 NaN 时抛出错误', () => {
    const chain = newFreshChain();
    const tx = new Transaction('addr1', 'addr2', NaN);
    expect(() => chain.addTransaction(tx)).toThrow();
  });
});

// ============================================================
// 第2组: 给自己转账
// ============================================================
describe('给自己转账', () => {
  it('from === to 时抛出 "不能给自己转账"', () => {
    const chain = newFreshChain();
    const wallet = generateWallet();
    const tx = new Transaction(wallet.address, wallet.address, 10);
    expect(() => chain.addTransaction(tx)).toThrow(/不能给自己转账/);
  });

  it('给自己转账即使有余额也被拒绝', () => {
    const chain = newFreshChain();
    const wallet = generateWallet();
    fundAddress(chain, wallet.address, 100);

    const tx = new Transaction(wallet.address, wallet.address, 10);
    tx.signTransaction(wallet.privateKey, wallet.publicKey);
    expect(() => chain.addTransaction(tx)).toThrow(/不能给自己转账/);
  });
});

// ============================================================
// 第3组: 签名验证相关
// ============================================================
describe('签名验证', () => {
  let alice, bob;

  beforeAll(() => {
    alice = generateWallet();
    bob = generateWallet();
  });

  it('未签名的普通交易抛出 "签名验证失败"', () => {
    const chain = newFreshChain();
    fundAddress(chain, alice.address, 100);

    const tx = new Transaction(alice.address, bob.address, 10);
    expect(() => chain.addTransaction(tx)).toThrow(/签名验证失败/);
  });

  it('公钥与地址不匹配的交易抛出错误', () => {
    const chain = newFreshChain();
    fundAddress(chain, alice.address, 100);

    const tx = new Transaction(alice.address, bob.address, 10);
    expect(() => {
      tx.signTransaction(alice.privateKey, bob.publicKey);
    }).toThrow();
  });

  it('签名被篡改的交易抛出 "签名验证失败"', () => {
    const chain = newFreshChain();
    fundAddress(chain, alice.address, 100);

    const tx = createSignedTx(alice, bob.address, 10);
    tx.signature = '00' + tx.signature.slice(2);
    expect(() => chain.addTransaction(tx)).toThrow(/签名验证失败/);
  });

  it('SYSTEM 奖励交易（from=SYSTEM）走不到 addTransaction（跳过边界检查）', () => {
    const chain = newFreshChain();
    const tx = new Transaction('SYSTEM', bob.address, 50, 0, 'Miner Reward');
    // SYSTEM 交易 from 非空, to 非空, amount>0, 无需签名
    // 但余额检查会失败（SYSTEM 没有余额）
    expect(() => chain.addTransaction(tx)).toThrow();
  });
});

// ============================================================
// 第4组: 余额检查
// ============================================================
describe('余额检查', () => {
  let alice, bob;

  beforeAll(() => {
    alice = generateWallet();
    bob = generateWallet();
  });

  it('余额恰好足够时交易成功添加', () => {
    const chain = newFreshChain();
    fundAddress(chain, alice.address, 50);

    const tx = createSignedTx(alice, bob.address, 50);
    const result = chain.addTransaction(tx);
    expect(result).toBeDefined();
  });

  it('余额不足（amount > 余额）时抛出 "余额不足"', () => {
    const chain = newFreshChain();
    fundAddress(chain, alice.address, 30);

    const tx = createSignedTx(alice, bob.address, 50);
    expect(() => chain.addTransaction(tx)).toThrow(/余额不足/);
  });

  it('费用导致总额超过余额时抛出 "余额不足"（余额=50, amount=40, fee=20）', () => {
    const chain = newFreshChain();
    fundAddress(chain, alice.address, 50);

    const tx = createSignedTx(alice, bob.address, 40, 20);
    expect(() => chain.addTransaction(tx)).toThrow(/余额不足/);
  });

  it('余额刚好等于 amount + fee 时成功', () => {
    const chain = newFreshChain();
    fundAddress(chain, alice.address, 50);

    const tx = createSignedTx(alice, bob.address, 40, 10);
    const result = chain.addTransaction(tx);
    expect(result).toBeDefined();
  });
});