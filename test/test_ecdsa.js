// ============================================================
// ECDSA 签名系统测试脚本
// 运行方式: node test_ecdsa.js
// ============================================================
const { Blockchain, Block, Transaction, generateWallet } = require('../src/blockchain');

let testCount = 0;
let passCount = 0;

function test(name, fn) {
    testCount++;
    try {
        const result = fn();
        if (result === true) {
            console.log(`  ✓ ${name}`);
            passCount++;
        } else {
            console.log(`  ✗ ${name}`);
            console.log(`    原因: ${result}`);
        }
    } catch (err) {
        console.log(`  ✗ ${name}`);
        console.log(`    异常: ${err.message}`);
    }
}

console.log('============================================================');
console.log('  第1组: 钱包生成测试');
console.log('============================================================');

let walletA, walletB;

test('generateWallet() 能生成包含 privateKey/publicKey/address 的对象', () => {
    const w = generateWallet();
    return (w.privateKey && w.publicKey && w.address) ? true : '缺少字段';
});

test('私钥是 PEM 格式（以 "-----BEGIN" 开头）', () => {
    const w = generateWallet();
    return w.privateKey.startsWith('-----BEGIN') ? true : `私钥格式错误: ${w.privateKey.substring(0, 30)}...`;
});

test('公钥是十六进制字符串（DER 编码）', () => {
    const w = generateWallet();
    return /^[0-9a-fA-F]+$/.test(w.publicKey) ? true : `公钥格式错误`;
});

test('地址是公钥 SHA256 的前 32 个十六进制字符', () => {
    const crypto = require('crypto');
    const w = generateWallet();
    const expectedAddr = crypto.createHash('sha256').update(w.publicKey, 'hex').digest('hex').substring(0, 32);
    return w.address === expectedAddr ? true : `地址不匹配: ${w.address} vs ${expectedAddr}`;
});

walletA = generateWallet();
walletB = generateWallet();
test('两个不同钱包的 address 不同', () => {
    return walletA.address !== walletB.address ? true : '地址居然相同！';
});

console.log('');
console.log('============================================================');
console.log('  第2组: ECDSA 签名测试');
console.log('============================================================');

test('普通交易能用正确的 privateKey/publicKey 签名', () => {
    const tx = new Transaction(walletA.address, walletB.address, 10, 1, '测试交易');
    tx.signTransaction(walletA.privateKey, walletA.publicKey);
    return (tx.signature && tx.signature.length > 20 && tx.publicKey === walletA.publicKey) ? true : '签名失败';
});

test('已签名交易的 isValid() 返回 true', () => {
    const tx = new Transaction(walletA.address, walletB.address, 10, 1, '测试交易');
    tx.signTransaction(walletA.privateKey, walletA.publicKey);
    return tx.isValid() === true ? true : 'isValid() 未返回 true';
});

test('未签名交易的 isValid() 返回 false', () => {
    const tx = new Transaction(walletA.address, walletB.address, 10, 1, '未签名测试');
    return tx.isValid() === false ? true : 'isValid() 应对未签名交易返回 false';
});

test('挖矿奖励交易（from=SYSTEM）无需签名，isValid() 返回 true', () => {
    const rewardTx = new Transaction('SYSTEM', walletB.address, 50, 0, 'Miner Reward');
    return rewardTx.isValid() === true ? true : '奖励交易应直接有效';
});

test('备注交易（from 为空）无需签名，isValid() 返回 true', () => {
    const noteTx = new Transaction('', 'NOTE', 0, 0, '备注测试');
    return noteTx.isValid() === true ? true : '备注交易应直接有效';
});

console.log('');
console.log('============================================================');
console.log('  第3组: 安全测试 —— 防止冒名签名');
console.log('============================================================');

test('用 A 的私钥但 B 的公钥签名应失败', () => {
    const tx = new Transaction(walletA.address, walletB.address, 10);
    let threw = false;
    try {
        tx.signTransaction(walletA.privateKey, walletB.publicKey);  // 公钥与 from 地址不匹配
    } catch (err) {
        threw = true;
    }
    return threw ? true : '应该抛出错误但没有';
});

test('篡改 amount 后签名失效', () => {
    const tx = new Transaction(walletA.address, walletB.address, 10);
    tx.signTransaction(walletA.privateKey, walletA.publicKey);
    const originalValid = tx.isValid();
    // 直接篡改 amount
    tx.amount = 999;
    const tamperedValid = tx.isValid();
    return originalValid === true && tamperedValid === false ? true : '篡改后签名仍有效！';
});

test('篡改 from 后签名失效', () => {
    const tx = new Transaction(walletA.address, walletB.address, 10);
    tx.signTransaction(walletA.privateKey, walletA.publicKey);
    tx.from = walletB.address;  // 把 from 改成别人
    return tx.isValid() === false ? true : '篡改 from 后签名仍有效！';
});

test('替换 signature 后验证失败', () => {
    const tx = new Transaction(walletA.address, walletB.address, 10);
    tx.signTransaction(walletA.privateKey, walletA.publicKey);
    tx.signature = 'a'.repeat(64);  // 伪造签名
    return tx.isValid() === false ? true : '伪造签名被接受了！';
});

console.log('');
console.log('============================================================');
console.log('  第4组: Blockchain 集成测试');
console.log('============================================================');

// 用一个不存在的端口号创建全新链，避免加载本地旧数据
function newFreshChain() {
    const chain = new Blockchain(99999);
    // 测试环境下关闭 coinbase 成熟期锁，让奖励立即可用
    chain.coinbaseMaturity = 0;
    return chain;
}

test('addTransaction 接受已正确签名的交易', () => {
    const chain = newFreshChain();
    const tx = new Transaction(walletA.address, walletB.address, 10, 1, '集成测试');
    tx.signTransaction(walletA.privateKey, walletA.publicKey);
    // 先给 walletA 发一笔挖矿奖励让它有钱
    chain.chain.push(new Block(1, new Date().toISOString(),
        [new Transaction('SYSTEM', walletA.address, 100, 0, 'Initial Coin')],
        chain.chain[0].hash
    ));
    chain.chain[1].mineBlock(chain.difficulty);
    const saved = chain.addTransaction(tx);
    return saved ? true : '合法交易被拒绝';
});

test('addTransaction 拒绝未签名的普通交易', () => {
    const chain = newFreshChain();
    // 给钱包 A 一些余额
    chain.chain.push(new Block(1, new Date().toISOString(),
        [new Transaction('SYSTEM', walletA.address, 100, 0, 'Initial Coin')],
        chain.chain[0].hash
    ));
    chain.chain[1].mineBlock(chain.difficulty);
    const tx = new Transaction(walletA.address, walletB.address, 10);
    // 故意不签名
    let threw = false;
    try {
        chain.addTransaction(tx);
    } catch (err) {
        threw = true;
    }
    return threw ? true : '未签名交易应被拒绝但被接受了';
});

console.log('');
console.log('============================================================');
console.log('  第5组: 完整流程测试 —— 转账 → 挖矿 → 验证');
console.log('============================================================');

test('完整流程: 生成钱包 → 获得奖励 → 转账 → 挖矿 → 链有效', () => {
    const chain = newFreshChain();
    const alice = generateWallet();
    const bob = generateWallet();

    // 区块 1: 给 Alice 100 币（挖矿奖励，无需签名）
    const rewardTx1 = new Transaction('SYSTEM', alice.address, 100, 0, 'Mining Reward');
    const block1 = new Block(1, new Date().toISOString(), [rewardTx1], chain.chain[0].hash);
    block1.mineBlock(chain.difficulty);
    chain.chain.push(block1);

    // Alice 给 Bob 转 30 币（需要 ECDSA 签名）
    const transferTx = new Transaction(alice.address, bob.address, 30, 2, '转账测试');
    transferTx.signTransaction(alice.privateKey, alice.publicKey);
    if (!transferTx.isValid()) return '转账交易签名无效';
    chain.pendingTransactions.push(transferTx);

    // 区块 2: 打包转账交易 + 新奖励
    const rewardTx2 = new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward');
    const block2 = new Block(2, new Date().toISOString(),
        [rewardTx2, transferTx], chain.chain[1].hash);
    block2.mineBlock(chain.difficulty);
    chain.chain.push(block2);

    // 验证整条链（包括交易签名验证）
    const valid = chain.isChainValid();
    // 验证余额
    const aliceBal = chain.getBalance(alice.address);
    const bobBal = chain.getBalance(bob.address);
    return (valid && aliceBal === 118 && bobBal === 30) ? true
        : `valid=${valid}, alice=${aliceBal}, bob=${bobBal}`;
});

test('篡改链上交易后 isChainValid 返回 false', () => {
    const chain = newFreshChain();
    const alice = generateWallet();

    const rewardTx = new Transaction('SYSTEM', alice.address, 100, 0, 'Mining Reward');
    const block1 = new Block(1, new Date().toISOString(), [rewardTx], chain.chain[0].hash);
    block1.mineBlock(chain.difficulty);
    chain.chain.push(block1);

    // 验证通过
    const before = chain.isChainValid();

    // 篡改：把区块里一笔交易的 amount 改大
    const tx = new Transaction(alice.address, 'attacker', 20);
    tx.signTransaction(alice.privateKey, alice.publicKey);
    chain.pendingTransactions.push(tx);
    const rewardTx2 = new Transaction('SYSTEM', alice.address, 50, 0, 'Mining Reward');
    const block2 = new Block(2, new Date().toISOString(),
        [rewardTx2, tx], chain.chain[1].hash);
    block2.mineBlock(chain.difficulty);
    chain.chain.push(block2);

    // 故意篡改：把转账金额改大（破坏签名 + 破坏区块 hash）
    chain.chain[2].transactions[1].amount = 999999;

    // isChainValid 现在应该返回 false
    const after = chain.isChainValid();
    return before === true && after === false ? true
        : `before=${before}, after=${after}（篡改后应返回 false）`;
});

console.log('');
console.log('============================================================');
console.log(`  测试结果: ${passCount} / ${testCount} 通过`);
console.log('============================================================');

if (passCount === testCount) {
    console.log('\n🎉 所有测试通过！ECDSA 签名系统工作正常。\n');
    process.exit(0);
} else {
    console.log(`\n⚠️  有 ${testCount - passCount} 个测试失败，请检查。\n`);
    process.exit(1);
}