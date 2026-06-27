// ============================================================
// addTransaction 边界条件单元测试
// 运行方式: node test/test_addtransaction.js
// ============================================================
const crypto = require('crypto');
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

// 创建一个干净的测试链（关闭 coinbase 锁、不加载旧数据）
function createTestChain() {
    const chain = new Blockchain(99998);
    chain.coinbaseMaturity = 0;
    chain.difficulty = 1;   // 低难度加速挖矿
    return chain;
}

// 给指定地址充值（添加挖矿奖励并挖矿确认）
function fundAddress(chain, address, amount) {
    const rewardTx = new Transaction('SYSTEM', address, amount, 0, 'Test Fund');
    const block = new Block(
        chain.chain.length,
        new Date().toISOString(),
        [rewardTx],
        chain.getLatestBlock().hash
    );
    block.mineBlock(chain.difficulty);
    chain.chain.push(block);
}

// 生成一个已签名的转账交易
function createSignedTx(wallet, to, amount, fee = 0, note = '') {
    const tx = new Transaction(wallet.address, to, amount, fee, note);
    tx.signTransaction(wallet.privateKey, wallet.publicKey);
    return tx;
}

// ============================================================
let alice, bob;

console.log('============================================================');
console.log('  第1组: 基本参数校验（无需余额/签名）');
console.log('============================================================');

test('from 为空时抛出 "交易必须包含 from, to, 和正数 amount"', () => {
    const chain = createTestChain();
    const tx = new Transaction('', 'addr1', 10);
    let threw = false;
    let msg = '';
    try {
        chain.addTransaction(tx);
    } catch (err) {
        threw = true;
        msg = err.message;
    }
    return (threw && msg.includes('必须包含 from')) ? true
        : threw ? `错误信息不匹配: ${msg}` : '未抛出错误';
});

test('from 为 undefined 时抛出错误', () => {
    const chain = createTestChain();
    const tx = new Transaction(undefined, 'addr1', 10);
    let threw = false;
    let msg = '';
    try {
        chain.addTransaction(tx);
    } catch (err) {
        threw = true;
        msg = err.message;
    }
    return (threw && msg.includes('必须包含 from')) ? true
        : threw ? `错误信息不匹配: ${msg}` : '未抛出错误';
});

test('from 为 null 时抛出错误', () => {
    const chain = createTestChain();
    const tx = new Transaction(null, 'addr1', 10);
    let threw = false;
    try {
        chain.addTransaction(tx);
    } catch (err) {
        threw = true;
    }
    return threw ? true : '未抛出错误';
});

test('to 为空时抛出 "交易必须包含 from, to, 和正数 amount"', () => {
    const chain = createTestChain();
    const tx = new Transaction('addr1', '', 10);
    let threw = false;
    let msg = '';
    try {
        chain.addTransaction(tx);
    } catch (err) {
        threw = true;
        msg = err.message;
    }
    return (threw && msg.includes('必须包含 from')) ? true
        : threw ? `错误信息不匹配: ${msg}` : '未抛出错误';
});

test('to 为 null 时抛出错误', () => {
    const chain = createTestChain();
    const tx = new Transaction('addr1', null, 10);
    let threw = false;
    try {
        chain.addTransaction(tx);
    } catch (err) {
        threw = true;
    }
    return threw ? true : '未抛出错误';
});

test('amount = 0 时抛出 "交易必须包含 from, to, 和正数 amount"', () => {
    const chain = createTestChain();
    const tx = new Transaction('addr1', 'addr2', 0);
    let threw = false;
    let msg = '';
    try {
        chain.addTransaction(tx);
    } catch (err) {
        threw = true;
        msg = err.message;
    }
    return (threw && msg.includes('必须包含 from')) ? true
        : threw ? `错误信息不匹配: ${msg}` : '未抛出错误';
});

test('amount 为负数（-10）时抛出错误', () => {
    const chain = createTestChain();
    const tx = new Transaction('addr1', 'addr2', -10);
    let threw = false;
    try {
        chain.addTransaction(tx);
    } catch (err) {
        threw = true;
    }
    return threw ? true : '未抛出错误';
});

test('amount 为 NaN 时抛出错误', () => {
    const chain = createTestChain();
    const tx = new Transaction('addr1', 'addr2', NaN);
    let threw = false;
    try {
        chain.addTransaction(tx);
    } catch (err) {
        threw = true;
    }
    return threw ? true : '未抛出错误';
});

console.log('');
console.log('============================================================');
console.log('  第2组: 给自己转账');
console.log('============================================================');

test('from === to 时抛出 "不能给自己转账"', () => {
    const chain = createTestChain();
    const wallet = generateWallet();
    const tx = new Transaction(wallet.address, wallet.address, 10);
    let threw = false;
    let msg = '';
    try {
        chain.addTransaction(tx);
    } catch (err) {
        threw = true;
        msg = err.message;
    }
    return (threw && msg.includes('不能给自己转账')) ? true
        : threw ? `错误信息不匹配: ${msg}` : '未抛出错误';
});

test('给自己转账即使有余额也被拒绝', () => {
    const chain = createTestChain();
    const wallet = generateWallet();
    fundAddress(chain, wallet.address, 100);

    const tx = new Transaction(wallet.address, wallet.address, 10);
    // 签名也没用
    tx.signTransaction(wallet.privateKey, wallet.publicKey);
    let threw = false;
    let msg = '';
    try {
        chain.addTransaction(tx);
    } catch (err) {
        threw = true;
        msg = err.message;
    }
    return (threw && msg.includes('不能给自己转账')) ? true
        : threw ? `错误信息不匹配: ${msg}` : '未抛出错误';
});

console.log('');
console.log('============================================================');
console.log('  第3组: 签名验证相关');
console.log('============================================================');

alice = generateWallet();
bob = generateWallet();

test('未签名的普通交易抛出 "交易签名验证失败"', () => {
    const chain = createTestChain();
    fundAddress(chain, alice.address, 100);

    const tx = new Transaction(alice.address, bob.address, 10); // 故意不签名
    let threw = false;
    let msg = '';
    try {
        chain.addTransaction(tx);
    } catch (err) {
        threw = true;
        msg = err.message;
    }
    return (threw && msg.includes('签名验证失败')) ? true
        : threw ? `错误信息不匹配: ${msg}` : '未抛出错误';
});

test('公钥与地址不匹配的交易抛出 "签名验证失败"', () => {
    const chain = createTestChain();
    fundAddress(chain, alice.address, 100);

    const tx = new Transaction(alice.address, bob.address, 10);
    // 用 alice 的私钥但 bob 的公钥签名
    let threw = false;
    try {
        tx.signTransaction(alice.privateKey, bob.publicKey);
    } catch (err) {
        threw = true;
    }
    // signTransaction 内部会先校验公钥与地址匹配
    return threw ? true : '公钥不匹配时应在 signTransaction 阶段就抛出错误';
});

test('签名被篡改的交易抛出 "签名验证失败"', () => {
    const chain = createTestChain();
    fundAddress(chain, alice.address, 100);

    const tx = createSignedTx(alice, bob.address, 10);
    tx.signature = '00' + tx.signature.slice(2); // 篡改签名
    let threw = false;
    let msg = '';
    try {
        chain.addTransaction(tx);
    } catch (err) {
        threw = true;
        msg = err.message;
    }
    return (threw && msg.includes('签名验证失败')) ? true
        : threw ? `错误信息不匹配: ${msg}` : '未抛出错误';
});

test('SYSTEM 奖励交易（from=SYSTEM）走不到 addTransaction（跳过边界检查）', () => {
    const chain = createTestChain();
    // SYSTEM 交易是通过 mineBlock 内部添加的，不会走 addTransaction
    // 但如果我们故意传给 addTransaction……
    const tx = new Transaction('SYSTEM', bob.address, 50, 0, 'Miner Reward');
    // SYSTEM 交易的 isValid() 返回 true（无需签名）
    // 但 addTransaction 中 !tx.from 对 'SYSTEM' 是 false → 通过
    // 所以这里可以正常添加（但实际业务中不会这么用）
    let threw = false;
    try {
        chain.addTransaction(tx);
    } catch (err) {
        threw = true;
    }
    // SYSTEM 交易 from 非空, to 非空, amount>0, 无需签名 → 应该通过
    // 但余额检查会失败（SYSTEM 没有余额）
    // 所以理论上会抛出余额不足异常
    return threw ? true : 'SYSTEM 交易本应因余额不足被拒绝';
});

console.log('');
console.log('============================================================');
console.log('  第4组: 余额检查');
console.log('============================================================');

test('余额恰好足够时交易成功添加', () => {
    const chain = createTestChain();
    const wallet = generateWallet();
    fundAddress(chain, wallet.address, 50);

    const tx = createSignedTx(wallet, bob.address, 50); // amount=50, fee=0
    const result = chain.addTransaction(tx);
    return result !== undefined ? true : '余额恰好足够却被拒绝';
});

test('余额不足（amount > 余额）时抛出 "余额不足"', () => {
    const chain = createTestChain();
    const wallet = generateWallet();
    fundAddress(chain, wallet.address, 30);

    const tx = createSignedTx(wallet, bob.address, 50);
    let threw = false;
    let msg = '';
    try {
        chain.addTransaction(tx);
    } catch (err) {
        threw = true;
        msg = err.message;
    }
    return (threw && msg.includes('余额不足')) ? true
        : threw ? `错误信息不匹配: ${msg}` : '未抛出错误';
});

test('费用导致总额超过余额时抛出 "余额不足"（余额=50, amount=40, fee=20）', () => {
    const chain = createTestChain();
    const wallet = generateWallet();
    fundAddress(chain, wallet.address, 50);

    const tx = createSignedTx(wallet, bob.address, 40, 20);
    let threw = false;
    let msg = '';
    try {
        chain.addTransaction(tx);
    } catch (err) {
        threw = true;
        msg = err.message;
    }
    return (threw && msg.includes('余额不足')) ? true
        : threw ? `错误信息不匹配: ${msg}` : '未抛出错误';
});

test('余额刚好等于 amount + fee 时成功', () => {
    const chain = createTestChain();
    const wallet = generateWallet();
    fundAddress(chain, wallet.address, 50);

    const tx = createSignedTx(wallet, bob.address, 40, 10); // 40+10=50，刚好够
    const result = chain.addTransaction(tx);
    return result !== undefined ? true : '余额刚好够却被拒绝';
});

test('余额为 0 时抛出 "余额不足"', () => {
    const chain = createTestChain();
    const wallet = generateWallet();
    // 不给钱包充钱，余额为 0

    const tx = createSignedTx(wallet, bob.address, 10);
    let threw = false;
    let msg = '';
    try {
        chain.addTransaction(tx);
    } catch (err) {
        threw = true;
        msg = err.message;
    }
    return (threw && msg.includes('余额不足')) ? true
        : threw ? `错误信息不匹配: ${msg}` : '未抛出错误';
});

console.log('');
console.log('============================================================');
console.log('  第5组: 交易池防双花（pendingOutgoing 检查）');
console.log('============================================================');

test('同一地址连发两笔总和不超过余额的交易，第二笔应成功', () => {
    const chain = createTestChain();
    const wallet = generateWallet();
    fundAddress(chain, wallet.address, 100);

    const tx1 = createSignedTx(wallet, bob.address, 30, 0, '第一笔');
    const tx2 = createSignedTx(wallet, bob.address, 40, 0, '第二笔');

    chain.addTransaction(tx1); // 第一笔成功（30 ≤ 100）
    const result = chain.addTransaction(tx2); // 第二笔也成功（30+40=70 ≤ 100）
    return result !== undefined ? true : '两笔总和未超余额，第二笔却被拒绝';
});

test('同一地址连发两笔总和超过余额，第二笔抛出 "余额不足"（防双花）', () => {
    const chain = createTestChain();
    const wallet = generateWallet();
    fundAddress(chain, wallet.address, 100);

    const tx1 = createSignedTx(wallet, bob.address, 60, 0, '第一笔');
    const tx2 = createSignedTx(wallet, bob.address, 50, 0, '第二笔'); // 60+50=110 > 100

    chain.addTransaction(tx1); // 第一笔成功（60 ≤ 100）

    let threw = false;
    let msg = '';
    try {
        chain.addTransaction(tx2); // 第二笔应因 pendingOutgoing=60 被拒
    } catch (err) {
        threw = true;
        msg = err.message;
    }
    return (threw && msg.includes('余额不足')) ? true
        : threw ? `错误信息不匹配: ${msg}` : '未抛出错误';
});

test('不同地址的交易互不影响', () => {
    const chain = createTestChain();
    const aliceWallet = generateWallet();
    const bobWallet = generateWallet();
    fundAddress(chain, aliceWallet.address, 100);
    fundAddress(chain, bobWallet.address, 50);

    const txAlice = createSignedTx(aliceWallet, bobWallet.address, 100, 0, 'Alice全转');
    const txBob = createSignedTx(bobWallet, aliceWallet.address, 50, 0, 'Bob全转');

    chain.addTransaction(txAlice); // Alice 花光 100
    const result = chain.addTransaction(txBob); // Bob 花 50，不受 Alice 影响
    return result !== undefined ? true : '不同地址的交易互相影响了';
});

test('第一笔挖矿后，pendingOutgoing 减少，可用余额正确释放', () => {
    const chain = createTestChain();
    chain.difficulty = 1;
    const wallet = generateWallet();
    fundAddress(chain, wallet.address, 100);

    // 发两笔：tx1=30, tx2=30，都在交易池中
    const tx1 = createSignedTx(wallet, bob.address, 30, 0, '第一笔');
    const tx2 = createSignedTx(wallet, bob.address, 30, 0, '第二笔');
    chain.addTransaction(tx1);
    chain.addTransaction(tx2); // pending: 30+30=60 ≤ 100 ✅

    // 挖矿打包全部待处理交易
    chain.mineBlock('miner');
    // 此时 tx1, tx2 已出块，钱包余额 = 100 - 30 - 30 = 40
    // pendingOutgoing = 0（交易池已空）
    // 再发第三笔 40（刚好用完余额）
    const tx3 = createSignedTx(wallet, bob.address, 40, 0, '第三笔');
    const result = chain.addTransaction(tx3);
    return result !== undefined ? true
        : '挖矿后余额=40，第三笔 40 应成功';

    // 如果发 41 则会因余额不足被拒
    // const tx4 = createSignedTx(wallet, bob.address, 41, 0, '超额');
    // chain.addTransaction(tx4); // 应抛异常
});

console.log('');
console.log('============================================================');
console.log('  第6组: 普通 JSON 对象传入兼容性');
console.log('============================================================');

test('普通 JSON 对象（有签名/公钥字段）也能通过 addTransaction', () => {
    const chain = createTestChain();
    const wallet = generateWallet();
    fundAddress(chain, wallet.address, 100);

    // 先创建一个 Transaction 并签名
    const tx = new Transaction(wallet.address, bob.address, 50, 2, 'JSON测试');
    tx.signTransaction(wallet.privateKey, wallet.publicKey);

    // 转为普通 JSON 对象
    const jsonTx = {
        id: tx.id,
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
        fee: tx.fee,
        note: tx.note,
        timestamp: tx.timestamp,
        signature: tx.signature,
        publicKey: tx.publicKey
    };

    const result = chain.addTransaction(jsonTx);
    return result !== undefined ? true : '普通 JSON 对象被拒绝';
});

test('普通 JSON 对象缺少 signature 字段被拒绝', () => {
    const chain = createTestChain();
    const wallet = generateWallet();
    fundAddress(chain, wallet.address, 100);

    const jsonTx = {
        from: wallet.address,
        to: bob.address,
        amount: 10,
        note: '无签名'
    };

    let threw = false;
    let msg = '';
    try {
        chain.addTransaction(jsonTx);
    } catch (err) {
        threw = true;
        msg = err.message;
    }
    return (threw && msg.includes('签名验证失败')) ? true
        : threw ? `错误信息不匹配: ${msg}` : '未抛出错误';
});

console.log('');
console.log('============================================================');
console.log('  第7组: fee 为负数边界');
console.log('============================================================');

test('fee 为负数 -5，amount=10，余额充足时可成功添加', () => {
    const chain = createTestChain();
    const wallet = generateWallet();
    fundAddress(chain, wallet.address, 100);

    // fee=-5，所需总额 = 10+(-5) = 5，反而更容易通过余额检查
    const tx = createSignedTx(wallet, bob.address, 10, -5, '负费用测试');

    // 查看 addTransaction 的金额计算: availableBalance < transaction.amount + transaction.fee
    // = availableBalance < 10 + (-5) = 5
    // 由于余额 100 ≥ 5，所以通过
    // 但这在业务上是有问题的行为——负费用相当于"凭空印钱"
    const result = chain.addTransaction(tx);
    return result !== undefined
        ? true : '负费用交易被拒绝（注意：这实际上是业务逻辑缺陷）';
});

test('fee 为负数 -100，amount=0 时因 amount<=0 被拒绝', () => {
    const chain = createTestChain();
    const wallet = generateWallet();

    const tx = createSignedTx(wallet, bob.address, 0, -100);
    let threw = false;
    try {
        chain.addTransaction(tx);
    } catch (err) {
        threw = true;
    }
    return threw ? true : 'amount=0 应被拒绝（即使 fee 为负）';
});

test('fee 为负数但签名仍有效（验证签名机制不受 fee 符号影响）', () => {
    // fee 是 calculateHash 的一部分，签名覆盖了 fee，所以签名本身是有效的
    const wallet = generateWallet();
    const tx = new Transaction(wallet.address, bob.address, 10, -5, '负费用');
    tx.signTransaction(wallet.privateKey, wallet.publicKey);
    return tx.isValid() === true ? true : '负费用的签名应仍然有效（费用是业务逻辑问题）';
});

console.log('');
console.log('============================================================');
console.log(`  测试结果: ${passCount} / ${testCount} 通过`);
console.log('============================================================');

if (passCount === testCount) {
    console.log('\n🎉 所有 addTransaction 边界测试通过！\n');
    process.exit(0);
} else {
    console.log(`\n⚠️  有 ${testCount - passCount} 个测试失败，请检查。\n`);
    process.exit(1);
}