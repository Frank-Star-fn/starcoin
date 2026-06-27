const { Blockchain, Block, Transaction, generateWallet } = require('../src/blockchain');

// ====== 模拟：A有100币（非奖励）转给矿工 30 币，此时矿工已有 50 奖励锁定。
// 正确行为：矿工可用 30 币（非奖励），但锁定奖励 50 不可花。
// 潜在bug：如果 getBalance 把锁定奖励算入或计算错误，就会出问题 ======

const starCoin = new Blockchain();

// 先清空链（重新初始化）
starCoin.chain = [starCoin.createGenesisBlock()];
starCoin.pendingTransactions = [];

// 生成钱包
const A = generateWallet();
const B = generateWallet();  // 矿工（也是用户）
const C = generateWallet();

console.log('A 的地址:', A.address);
console.log('B(矿工) 的地址:', B.address);
console.log('锁定期:', starCoin.coinbaseMaturity, '个区块');

// --- 让 A 在创世之后通过普通交易获得一些币（非奖励）---
// 简化：让系统挖矿到 A 的地址若干次，然后让 A 转到 B
// 但是所有 mining 奖励都被视为 coinbase，都有锁定期。
// 所以 A 的"非锁定来源的币"实际上很难得到，除非我们直接构造 non-coinbase 交易。
// 更直接的测试：让 B 先作为矿工挖矿得到锁定奖励，然后看 B 是否能用锁定奖励付款。

console.log('\n====== 场景1：B 挖出 1 个区块（得 50 锁定奖励），然后尝试花 50 ======');
starCoin.mineBlock(B.address);  // #1 区块：奖励50给B
console.log('挖出区块 #1, B 得到 50 币（锁定，直到 #6）');
console.log('B 的可用余额:', starCoin.getBalance(B.address));
console.log('B 的总余额(含锁定):', starCoin.getBalance(B.address, true));
console.log('B 的锁定奖励:', starCoin.getLockedRewards(B.address));

try {
    const tx = new Transaction(B.address, C.address, 50, 0, 'try-spend-locked');
    tx.signTransaction(B.privateKey, B.publicKey);
    starCoin.addTransaction(tx);
    console.log('❌ BUG: 花 50 锁定币成功!');
} catch (err) {
    console.log('✅ 正确: B 不能花 50 锁定币 -', err.message);
}

// --- 继续挖出 4 个空区块到链尾 #5，此时 B 在 #1 的奖励还差 1 个块到期 ---
console.log('\n继续挖矿 3 个块（链尾到 #4），B 的奖励还差一点点成熟...');
for (let i = 0; i < 3; i++) {
    starCoin.pendingTransactions = [];
    starCoin.mineBlock('SOMEONE_' + i);
}
console.log('当前链尾:', starCoin.getLatestBlock().index);
console.log('B 的可用余额:', starCoin.getBalance(B.address));
console.log('B 的锁定奖励:', starCoin.getLockedRewards(B.address));

try {
    const tx = new Transaction(B.address, C.address, 50, 0, 'try-before-mature');
    tx.signTransaction(B.privateKey, B.publicKey);
    starCoin.addTransaction(tx);
    console.log('❌ BUG: 奖励未成熟但仍然能花!');
} catch (err) {
    console.log('✅ 正确: 奖励未成熟，无法花 -', err.message);
}

// --- 再挖 1 个块（#5），还差一个块；再挖一个(#6)，奖励成熟! ---
starCoin.pendingTransactions = [];
starCoin.mineBlock('SOMEONE_5');  // #5
starCoin.pendingTransactions = [];
starCoin.mineBlock('SOMEONE_6');  // #6
console.log('\n链尾:', starCoin.getLatestBlock().index);
console.log('B 的可用余额:', starCoin.getBalance(B.address));
console.log('B 的锁定奖励:', starCoin.getLockedRewards(B.address));

try {
    const tx = new Transaction(B.address, C.address, 50, 0, 'spend-after-mature');
    tx.signTransaction(B.privateKey, B.publicKey);
    starCoin.addTransaction(tx);
    console.log('✅ 正确: 奖励已成熟，可以花');
} catch (err) {
    console.log('❌ BUG: 奖励已成熟但无法花 -', err.message);
}

// --- 新挖矿奖励又应该锁定 ---
console.log('\n====== 场景2：B 再挖矿得到新奖励（锁定），尝试立刻花掉 ======');
starCoin.pendingTransactions = [];
starCoin.mineBlock(B.address);  // #7，奖励50（锁定直到 #12）
console.log('挖出区块 #7，B 又得 50（锁定）');
console.log('B 可用余额 (应 =50 旧奖励已成熟):', starCoin.getBalance(B.address));
console.log('B 锁定奖励 (应 =50):', starCoin.getLockedRewards(B.address));

try {
    // 尝试花 99 币（50 可用 + 49 锁定 = 超过可用）
    const tx = new Transaction(B.address, C.address, 99, 0, 'spend-more-than-available');
    tx.signTransaction(B.privateKey, B.publicKey);
    starCoin.addTransaction(tx);
    console.log('❌ BUG: 花了超过可用余额 (50可用 但花了99)!');
} catch (err) {
    console.log('✅ 正确: 超过可用余额 -', err.message);
}

// 尝试刚好花 50 可用（应成功）
try {
    const tx = new Transaction(B.address, C.address, 50, 0, 'spend-exact-available');
    tx.signTransaction(B.privateKey, B.publicKey);
    starCoin.addTransaction(tx);
    console.log('✅ 正确: 花 50 可用成功');
} catch (err) {
    console.log('❌ BUG: 应该能花 50 但失败了 -', err.message);
}

console.log('\n===== 测试完成 =====');