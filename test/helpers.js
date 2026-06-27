// ============================================================
// 共享测试工具函数
// 供所有 .test.js 文件使用
// ============================================================
const { Blockchain, Block, Transaction, generateWallet } = require('../src/blockchain');

/**
 * 创建一个全新的测试链（不加载旧数据、关闭 coinbase 锁、低难度）
 */
function newFreshChain() {
  const randomPort = Math.floor(Math.random() * 90000) + 10000;
  const chain = new Blockchain(randomPort);
  chain.coinbaseMaturity = 0;
  chain.difficulty = 1;
  chain.pendingTransactions = [];
  return chain;
}

/**
 * 给指定地址充值（添加挖矿奖励并挖矿确认）
 */
function fundAddress(chain, address, amount) {
  const rewardTx = new Transaction('SYSTEM', address, amount, 0, 'Test Fund');
  const block = new Block(
    chain.chain.length,
    new Date().toISOString(),
    [rewardTx],
    chain.getLatestBlock().hash,
  );
  block.mineBlock(chain.difficulty);
  chain.chain.push(block);
}

/**
 * 生成一个已签名的转账交易
 */
function createSignedTx(wallet, to, amount, fee = 0, note = '') {
  const tx = new Transaction(wallet.address, to, amount, fee, note);
  tx.signTransaction(wallet.privateKey, wallet.publicKey);
  return tx;
}

module.exports = { newFreshChain, fundAddress, createSignedTx };