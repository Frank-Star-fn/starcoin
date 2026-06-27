// ============================================================
// P2P 交易池广播 — 单元测试
// 覆盖: 交易池去重、P2P 交易接收、区块确认清理、链替换清理
// 运行方式: node test/test_mempool_p2p.js
// ============================================================
const { Blockchain, Block, Transaction, generateWallet, importWalletFromPem } = require('../src/blockchain');
const crypto = require('crypto');

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
        console.log(`    堆栈: ${err.stack.split('\n').slice(1, 3).join('\n')}`);
    }
}

function newFreshChain() {
    // 使用随机端口号确保每次都是全新链（避免旧文件干扰）
    const randomPort = Math.floor(Math.random() * 90000) + 10000;
    const chain = new Blockchain(randomPort);
    chain.coinbaseMaturity = 0;
    // 确保交易池为空
    chain.pendingTransactions = [];
    return chain;
}

// ==================== 辅助函数 ====================

/**
 * 给链添加一个包含挖矿奖励的区块（让钱包获得余额）
 */
function mineRewardBlock(chain, address, amount = 100) {
    const rewardTx = new Transaction('SYSTEM', address, amount, 0, 'Test Reward');
    const prevBlock = chain.getLatestBlock();
    const block = new Block(prevBlock.index + 1, new Date().toISOString(), [rewardTx], prevBlock.hash);
    block.mineBlock(chain.difficulty);
    chain.chain.push(block);
}

/**
 * 创建一个签名的转账交易
 */
function createSignedTx(fromWallet, toAddress, amount, fee = 0, note = '') {
    const tx = new Transaction(fromWallet.address, toAddress, amount, fee, note);
    tx.signTransaction(fromWallet.privateKey, fromWallet.publicKey);
    return tx;
}

// ============================================================
//  第1组: hasPendingTransaction() — 去重检查
// ============================================================
console.log('============================================================');
console.log('  第1组: hasPendingTransaction() — 交易池去重基础检查');
console.log('============================================================');

let walletA, walletB;
walletA = generateWallet();
walletB = generateWallet();

test('空交易池中查询任意 ID 返回 false', () => {
    const chain = newFreshChain();
    return chain.hasPendingTransaction('nonexistent-id-12345') === false ? true
        : '空池应返回 false';
});

test('交易存在时 hasPendingTransaction 返回 true', () => {
    const chain = newFreshChain();
    const tx = createSignedTx(walletA, walletB.address, 10, 1);
    chain.pendingTransactions.push(tx);
    return chain.hasPendingTransaction(tx.id) === true ? true
        : '交易存在应返回 true';
});

test('交易不存在时 hasPendingTransaction 返回 false', () => {
    const chain = newFreshChain();
    const tx1 = createSignedTx(walletA, walletB.address, 10, 1);
    const tx2 = createSignedTx(walletA, walletB.address, 20, 1);
    chain.pendingTransactions.push(tx1);
    return chain.hasPendingTransaction(tx2.id) === false ? true
        : '不同 ID 的交易应返回 false';
});

test('交易池有多个交易时仍能准确查找', () => {
    const chain = newFreshChain();
    const txs = [
        createSignedTx(walletA, walletB.address, 10, 1),
        createSignedTx(walletB, walletA.address, 5, 1),
        createSignedTx(walletA, walletB.address, 3, 1)
    ];
    txs.forEach(t => chain.pendingTransactions.push(t));
    const allFound = txs.every(t => chain.hasPendingTransaction(t.id));
    const notFound = !chain.hasPendingTransaction('bogus-id');
    return (allFound && notFound) ? true
        : `allFound=${allFound}, notFound=${notFound}`;
});

// ============================================================
//  第2组: addPendingTransaction() — P2P 交易接收
// ============================================================
console.log('');
console.log('============================================================');
console.log('  第2组: addPendingTransaction() — P2P 交易接收与验证');
console.log('============================================================');

test('跳过余额检查：接收有效的签名交易', () => {
    const chain = newFreshChain();
    const tx = createSignedTx(walletA, walletB.address, 99999, 1, '大额P2P测试');
    const result = chain.addPendingTransaction(tx, true);
    return (result.success === true &&
            result.transaction &&
            result.transaction.id === tx.id) ? true
        : `success=${result.success}, error=${result.error}`;
});

test('跳过余额检查：SYSTEM 奖励交易可以直接接收', () => {
    const chain = newFreshChain();
    const rewardTx = new Transaction('SYSTEM', walletA.address, 50, 0, 'Mining Reward');
    const result = chain.addPendingTransaction(rewardTx, true);
    return result.success === true ? true
        : `SYSTEM 奖励交易被拒绝: ${result.error}`;
});

test('不跳过余额检查：余额充足时成功', () => {
    const chain = newFreshChain();
    mineRewardBlock(chain, walletA.address, 100);
    const tx = createSignedTx(walletA, walletB.address, 30, 2);
    const result = chain.addPendingTransaction(tx, false); // 不跳过余额检查
    return result.success === true ? true
        : `余额充足却被拒绝: ${result.error}`;
});

test('不跳过余额检查：余额不足时失败', () => {
    const chain = newFreshChain();
    // 不给 walletA 任何余额
    const tx = createSignedTx(walletA, walletB.address, 30, 2);
    const result = chain.addPendingTransaction(tx, false); // 不跳过余额检查
    return (result.success === false &&
            result.error &&
            result.error.includes('余额不足')) ? true
        : `余额不足时应失败: ${result.error || 'no error'}`;
});

test('重复交易 ID 被拒绝（去重保护）', () => {
    const chain = newFreshChain();
    const tx = createSignedTx(walletA, walletB.address, 10, 1);
    // 先加入一次
    const first = chain.addPendingTransaction(tx, true);
    // 再次加入（同一对象，同一 ID）
    const second = chain.addPendingTransaction(tx, true);
    return (first.success === true &&
            second.success === false &&
            second.error &&
            second.error.includes('已存在于交易池')) ? true
        : `first=${first.success}, second=${second.success}, error=${second.error}`;
});

test('同一笔交易数据（相同 ID）重复添加被拒绝', () => {
    const chain = newFreshChain();
    const tx1 = createSignedTx(walletA, walletB.address, 10, 1);
    const first = chain.addPendingTransaction(tx1, true);

    // 构造一个 ID 相同但其他字段不同的交易（模拟广播重复）
    const tx2 = new Transaction(walletA.address, walletB.address, 10, 1);
    tx2.signature = tx1.signature;
    tx2.publicKey = tx1.publicKey;
    tx2.timestamp = tx1.timestamp;
    tx2.id = tx1.id; // 强行设成相同 ID

    const second = chain.addPendingTransaction(tx2, true);
    return (first.success === true &&
            second.success === false &&
            chain.pendingTransactions.length === 1) ? true
        : `池大小=${chain.pendingTransactions.length}, 应为 1, second=${second.success}`;
});

test('无效签名交易被拒绝', () => {
    const chain = newFreshChain();
    const tx = new Transaction(walletA.address, walletB.address, 10, 1, '未签名测试');
    // 故意不签名
    const result = chain.addPendingTransaction(tx, true);
    return (result.success === false &&
            result.error &&
            result.error.includes('签名验证失败')) ? true
        : `无效签名未被拒绝: ${JSON.stringify(result)}`;
});

test('假冒签名（A 的私钥 + B 的公钥）的交易被拒绝', () => {
    const chain = newFreshChain();
    // 构造一个 from=walletA.address 但用 walletB 的公钥签名的交易
    const tx = new Transaction(walletA.address, walletB.address, 10, 1);
    let threw = false;
    try {
        tx.signTransaction(walletA.privateKey, walletB.publicKey);
    } catch (e) {
        threw = true;
    }
    if (!threw) return 'signTransaction 应该检测到公钥不匹配';

    const result = chain.addPendingTransaction(tx, true);
    // signTransaction 会抛异常，所以 tx 没有签名
    return (result.success === false) ? true
        : `假冒签名交易被接受: ${JSON.stringify(result)}`;
});

test('缺少 from 字段被拒绝', () => {
    const chain = newFreshChain();
    const tx = new Transaction('', walletB.address, 10, 1, '无发送方');
    const result = chain.addPendingTransaction(tx, true);
    return (result.success === false &&
            result.error &&
            result.error.includes('缺少必要字段')) ? true
        : `缺少 from 应被拒绝: ${result.error || 'no error'}`;
});

test('给自己转账被拒绝', () => {
    const chain = newFreshChain();
    const tx = createSignedTx(walletA, walletA.address, 10, 1, '自转账');
    const result = chain.addPendingTransaction(tx, true);
    return (result.success === false &&
            result.error &&
            result.error.includes('不能给自己转账')) ? true
        : `自转账应被拒绝: ${result.error || 'no error'}`;
});

test('金额为零被拒绝', () => {
    const chain = newFreshChain();
    const tx = createSignedTx(walletA, walletB.address, 0, 1, '零金额');
    const result = chain.addPendingTransaction(tx, true);
    return (result.success === false &&
            result.error &&
            result.error.includes('缺少必要字段')) ? true
        : `零金额应被拒绝: ${result.error || 'no error'}`;
});

test('金额为负数被拒绝', () => {
    const chain = newFreshChain();
    const tx = createSignedTx(walletA, walletB.address, -5, 1, '负金额');
    const result = chain.addPendingTransaction(tx, true);
    return (result.success === false) ? true
        : `负金额应被拒绝: ${result.error || 'no error'}`;
});

test('P2P 接收的交易加入交易池后，池大小正确增加', () => {
    const chain = newFreshChain();
    const txs = [
        createSignedTx(walletA, walletB.address, 10, 1),
        createSignedTx(walletB, walletA.address, 5, 1),
    ];

    // 从外部 JSON 对象形式加入（模拟 WebSocket 收到的反序列化数据）
    const rawTx1 = {
        id: txs[0].id,
        from: txs[0].from,
        to: txs[0].to,
        amount: txs[0].amount,
        fee: txs[0].fee,
        note: txs[0].note,
        timestamp: txs[0].timestamp,
        signature: txs[0].signature,
        publicKey: txs[0].publicKey
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
        publicKey: txs[1].publicKey
    };

    const r1 = chain.addPendingTransaction(rawTx1, true);
    const r2 = chain.addPendingTransaction(rawTx2, true);
    return (r1.success && r2.success && chain.pendingTransactions.length === 2) ? true
        : `池大小=${chain.pendingTransactions.length}, r1=${r1.success}, r2=${r2.success}`;
});

// ============================================================
//  第3组: addBlock() — 区块确认后交易池清理
// ============================================================
console.log('');
console.log('============================================================');
console.log('  第3组: addBlock() — 区块确认后交易池清理');
console.log('============================================================');

test('添加含交易的区块后，交易池中该交易被移除', () => {
    const chain = newFreshChain();
    mineRewardBlock(chain, walletA.address, 100);

    const tx = createSignedTx(walletA, walletB.address, 30, 2);
    chain.pendingTransactions.push(tx);
    chain.pendingTransactions.push(
        createSignedTx(walletA, walletB.address, 5, 1)
    );

    const before = chain.pendingTransactions.length;

    // 模拟 P2P 收到一个包含 tx 的区块
    const rewardTx = new Transaction('SYSTEM', walletA.address, 50, 0, 'Mining Reward');
    const newBlock = new Block(
        chain.getLatestBlock().index + 1,
        new Date().toISOString(),
        [rewardTx, tx], // 区块包含了 tx
        chain.getLatestBlock().hash
    );
    newBlock.mineBlock(chain.difficulty);
    chain.addBlock(newBlock);

    // tx 应该从 pendingTransactions 中移除
    return (chain.hasPendingTransaction(tx.id) === false &&
            chain.pendingTransactions.length === before - 1) ? true
        : `tx 仍在池中: ${chain.hasPendingTransaction(tx.id)}, 池大小: ${chain.pendingTransactions.length} (应为 ${before - 1})`;
});

test('添加不含已知交易的区块，交易池不变', () => {
    const chain = newFreshChain();
    mineRewardBlock(chain, walletA.address, 100);

    const tx1 = createSignedTx(walletA, walletB.address, 10, 1);
    const tx2 = createSignedTx(walletA, walletB.address, 20, 1);
    chain.pendingTransactions.push(tx1, tx2);

    const before = chain.pendingTransactions.length;
    const beforeHasTx1 = chain.hasPendingTransaction(tx1.id);

    // 挖一个只包含奖励交易的区块（没有 tx1/tx2）
    const rewardTx = new Transaction('SYSTEM', walletA.address, 50, 0, 'Mining Reward');
    const newBlock = new Block(
        chain.getLatestBlock().index + 1,
        new Date().toISOString(),
        [rewardTx],
        chain.getLatestBlock().hash
    );
    newBlock.mineBlock(chain.difficulty);
    chain.addBlock(newBlock);

    return (chain.pendingTransactions.length === before &&
            chain.hasPendingTransaction(tx1.id) === beforeHasTx1) ? true
        : `池大小变化: ${chain.pendingTransactions.length} vs ${before}`;
});

test('区块中的多个交易都被移出交易池', () => {
    const chain = newFreshChain();
    mineRewardBlock(chain, walletA.address, 200);

    const txs = [
        createSignedTx(walletA, walletB.address, 10, 1, '打包测试1'),
        createSignedTx(walletA, walletB.address, 20, 1, '打包测试2'),
        createSignedTx(walletA, walletB.address, 30, 1, '打包测试3'),
    ];
    txs.forEach(t => chain.pendingTransactions.push(t));

    // 留一个不在区块中的交易
    const remainingTx = createSignedTx(walletA, walletB.address, 5, 1, '保留测试');
    chain.pendingTransactions.push(remainingTx);

    const rewardTx = new Transaction('SYSTEM', walletA.address, 50, 0, 'Mining Reward');
    const newBlock = new Block(
        chain.getLatestBlock().index + 1,
        new Date().toISOString(),
        [rewardTx, ...txs],
        chain.getLatestBlock().hash
    );
    newBlock.mineBlock(chain.difficulty);
    chain.addBlock(newBlock);

    const allRemoved = txs.every(t => !chain.hasPendingTransaction(t.id));
    const remainingExists = chain.hasPendingTransaction(remainingTx.id);
    return (allRemoved && remainingExists &&
            chain.pendingTransactions.length === 1) ? true
        : `池大小=${chain.pendingTransactions.length}(应为1), allRemoved=${allRemoved}, remainingExists=${remainingExists}`;
});

// ============================================================
//  第4组: replaceChain() — 链替换后交易池清理
// ============================================================
console.log('');
console.log('============================================================');
console.log('  第4组: replaceChain() — 链替换后交易池清理与回滚');
console.log('============================================================');

const ChainSync = require('../src/chain-sync').ChainSync;

test('替换链后，新链中已确认的交易从交易池移除', () => {
    const chain = newFreshChain();
    mineRewardBlock(chain, walletA.address, 100);

    const tx = createSignedTx(walletA, walletB.address, 30, 2);
    chain.pendingTransactions.push(tx);

    // 构造一条更长的链，其中包含 tx
    const newChain = [chain.chain[0], chain.chain[1]]; // genesis + reward block
    const rewardTx = new Transaction('SYSTEM', walletA.address, 50, 0, 'Mining Reward');
    const blockWithTx = new Block(2, new Date().toISOString(), [rewardTx, tx], chain.chain[1].hash);
    blockWithTx.mineBlock(chain.difficulty);
    newChain.push(blockWithTx);

    // 再挖一个区块让它更长
    const extraReward = new Transaction('SYSTEM', walletA.address, 50, 0, 'Extra');
    const extraBlock = new Block(3, new Date().toISOString(), [extraReward], blockWithTx.hash);
    extraBlock.mineBlock(chain.difficulty);
    newChain.push(extraBlock);

    // 确保新链更长且有效
    const sync = new ChainSync(chain);
    const result = sync.replaceChain(newChain);

    return (result === true &&
            !chain.hasPendingTransaction(tx.id)) ? true
        : `替换失败或 tx 仍在池中: result=${result}, hasTx=${chain.hasPendingTransaction(tx.id)}`;
});

test('替换链后，旧链有但新链没有的交易被回滚到交易池', () => {
    const chain = newFreshChain();
    // 构造旧链: genesis → reward → blockA（含 txA）
    mineRewardBlock(chain, walletA.address, 100);
    const txA = createSignedTx(walletA, walletB.address, 20, 1, '旧链交易');
    const rewardA = new Transaction('SYSTEM', walletA.address, 50, 0, 'Reward A');
    const blockA = new Block(2, new Date().toISOString(), [rewardA, txA], chain.chain[1].hash);
    blockA.mineBlock(chain.difficulty);
    chain.chain.push(blockA);

    // 此时 chain = [genesis, reward, blockA]
    // 交易池中不应该有 txA（它在区块里）
    chain.pendingTransactions = []; // 确保清理

    // 构造新链: genesis → reward → blockB（不含 txA，但更长）
    const rewardB = new Transaction('SYSTEM', walletA.address, 50, 0, 'Reward B');
    const blockB = new Block(2, new Date().toISOString(), [rewardB], chain.chain[1].hash);
    blockB.mineBlock(chain.difficulty);

    const extraReward = new Transaction('SYSTEM', walletA.address, 50, 0, 'Extra B');
    const extraBlock = new Block(3, new Date().toISOString(), [extraReward], blockB.hash);
    extraBlock.mineBlock(chain.difficulty);

    const newChain = [chain.chain[0], chain.chain[1], blockB, extraBlock];

    const sync = new ChainSync(chain);
    const result = sync.replaceChain(newChain);

    // txA 不在新链中，应被回滚到 pendingTransactions
    return (result === true &&
            chain.hasPendingTransaction(txA.id)) ? true
        : `替换失败或 txA 未被回滚: result=${result}, hasTxA=${chain.hasPendingTransaction(txA.id)}`;
});

test('替换链后，旧链和新链都有的交易不回滚', () => {
    const chain = newFreshChain();
    mineRewardBlock(chain, walletA.address, 100);

    const sharedTx = createSignedTx(walletA, walletB.address, 15, 1, '共享交易');

    // 旧链包含 sharedTx
    const rewardA = new Transaction('SYSTEM', walletA.address, 50, 0, 'Reward A');
    const blockA = new Block(2, new Date().toISOString(), [rewardA, sharedTx], chain.chain[1].hash);
    blockA.mineBlock(chain.difficulty);
    chain.chain.push(blockA);
    chain.pendingTransactions = [];

    // 新链也包含 sharedTx
    const rewardB = new Transaction('SYSTEM', walletA.address, 50, 0, 'Reward B');
    const blockB = new Block(2, new Date().toISOString(), [rewardB, sharedTx], chain.chain[1].hash);
    blockB.mineBlock(chain.difficulty);

    const extraReward = new Transaction('SYSTEM', walletA.address, 50, 0, 'Extra B');
    const extraBlock = new Block(3, new Date().toISOString(), [extraReward], blockB.hash);
    extraBlock.mineBlock(chain.difficulty);

    const newChain = [chain.chain[0], chain.chain[1], blockB, extraBlock];

    const sync = new ChainSync(chain);
    const result = sync.replaceChain(newChain);

    // sharedTx 在新链中已确认，不应在交易池中
    return (result === true &&
            !chain.hasPendingTransaction(sharedTx.id)) ? true
        : `替换失败或 sharedTx 被错误回滚: result=${result}, hasTx=${chain.hasPendingTransaction(sharedTx.id)}`;
});

// ============================================================
//  第5组: 防广播风暴 — 去重保护
// ============================================================
console.log('');
console.log('============================================================');
console.log('  第5组: 防广播风暴 — 交易去重保护');
console.log('============================================================');

test('同一笔交易从不同来源多次添加，池中只有一份', () => {
    const chain = newFreshChain();
    const tx = createSignedTx(walletA, walletB.address, 10, 1, '防风暴测试');

    // 模拟从 3 个不同节点收到同一笔交易
    const r1 = chain.addPendingTransaction(tx, true);
    const r2 = chain.addPendingTransaction(tx, true);
    const r3 = chain.addPendingTransaction(tx, true);

    return (r1.success === true &&
            r2.success === false &&
            r3.success === false &&
            chain.pendingTransactions.length === 1) ? true
        : `池大小=${chain.pendingTransactions.length}, r1=${r1.success}, r2=${r2.success}, r3=${r3.success}`;
});

test('大量重复交易到达，池中只保留唯一交易', () => {
    const chain = newFreshChain();
    const tx = createSignedTx(walletA, walletB.address, 10, 1, '大量重复');

    for (let i = 0; i < 100; i++) {
        chain.addPendingTransaction(tx, true);
    }

    return chain.pendingTransactions.length === 1 ? true
        : `池大小=${chain.pendingTransactions.length}（应为 1）`;
});

// ============================================================
//  第6组: 端到端完整流程
// ============================================================
console.log('');
console.log('============================================================');
console.log('  第6组: 端到端完整流程 — P2P 交易 → 挖矿 → 清理');
console.log('============================================================');

test('完整流程: P2P 接收交易 → 本地挖矿 → 交易从池中移除', () => {
    const chain = newFreshChain();
    mineRewardBlock(chain, walletA.address, 100);

    // 模拟 P2P 接收一笔交易
    const tx = createSignedTx(walletA, walletB.address, 30, 2, 'P2P 端到端测试');
    const p2pResult = chain.addPendingTransaction(tx, true);
    if (!p2pResult.success) return `P2P 接收失败: ${p2pResult.error}`;
    if (chain.pendingTransactions.length !== 1) return '交易池大小应为 1';

    // 本地挖矿
    const newBlock = chain.mineBlock(walletA.address);
    if (!newBlock) return '挖矿失败';

    // 交易池应该被清理
    return (!chain.hasPendingTransaction(tx.id) &&
            chain.pendingTransactions.length === 0) ? true
        : `挖矿后 tx 仍在池中: ${chain.hasPendingTransaction(tx.id)}, 池大小=${chain.pendingTransactions.length}`;
});

test('完整流程: P2P 接收交易 → P2P 收到含该交易的区块 → 交易从池中移除', () => {
    const chain = newFreshChain();
    mineRewardBlock(chain, walletA.address, 100);

    // 模拟 P2P 接收一笔交易
    const tx = createSignedTx(walletA, walletB.address, 30, 2, 'P2P 区块清理测试');
    const p2pResult = chain.addPendingTransaction(tx, true);
    if (!p2pResult.success) return `P2P 接收失败: ${p2pResult.error}`;

    // 模拟从另一个节点收到一个包含该交易的区块
    const rewardTx = new Transaction('SYSTEM', walletA.address, 50, 0, 'Mining Reward');
    const block = new Block(
        chain.getLatestBlock().index + 1,
        new Date().toISOString(),
        [rewardTx, tx],
        chain.getLatestBlock().hash
    );
    block.mineBlock(chain.difficulty);
    chain.addBlock(block);

    return (!chain.hasPendingTransaction(tx.id) &&
            chain.pendingTransactions.length === 0) ? true
        : `addBlock 后 tx 仍在池中: ${chain.hasPendingTransaction(tx.id)}, 池大小=${chain.pendingTransactions.length}`;
});

test('完整流程: 两笔交易 → 挖矿只包含其中一笔 → 池中剩下另一笔', () => {
    const chain = newFreshChain();
    mineRewardBlock(chain, walletA.address, 200);

    const txA = createSignedTx(walletA, walletB.address, 10, 1, '打包交易');
    const txB = createSignedTx(walletA, walletB.address, 20, 1, '未打包交易');

    chain.pendingTransactions.push(txA, txB);

    // 挖只包含 txA 的区块
    const rewardTx = new Transaction('SYSTEM', walletA.address, 50, 0, 'Reward');
    const block = new Block(
        chain.getLatestBlock().index + 1,
        new Date().toISOString(),
        [rewardTx, txA],
        chain.getLatestBlock().hash
    );
    block.mineBlock(chain.difficulty);
    chain.addBlock(block);

    return (!chain.hasPendingTransaction(txA.id) &&
            chain.hasPendingTransaction(txB.id) &&
            chain.pendingTransactions.length === 1) ? true
        : `txA in pool: ${chain.hasPendingTransaction(txA.id)}, txB in pool: ${chain.hasPendingTransaction(txB.id)}, size: ${chain.pendingTransactions.length}`;
});

// ============================================================
//  第7组: 边界情况 — 矿工费与余额精确计算
// ============================================================
console.log('');
console.log('============================================================');
console.log('  第7组: 边界情况 — 矿工费与余额计算');
console.log('============================================================');

test('addPendingTransaction 不跳过余额：account for fee in balance check', () => {
    const chain = newFreshChain();
    mineRewardBlock(chain, walletA.address, 100); // walletA 有 100

    // 用足全部余额（amount + fee = 100）
    const tx = createSignedTx(walletA, walletB.address, 98, 2, '全部花掉');
    const result = chain.addPendingTransaction(tx, false);
    return result.success === true ? true
        : `余额刚好够却被拒绝: ${result.error}`;
});

test('addPendingTransaction 不跳过余额：amount + fee 超过余额时失败', () => {
    const chain = newFreshChain();
    mineRewardBlock(chain, walletA.address, 100);

    // amount + fee = 101 > 100
    const tx = createSignedTx(walletA, walletB.address, 99, 2, '超额');
    const result = chain.addPendingTransaction(tx, false);
    return (result.success === false &&
            result.error &&
            result.error.includes('余额不足')) ? true
        : `超额应失败: ${JSON.stringify(result)}`;
});

test('addPendingTransaction 不跳过余额：pending 中待花费也计入余额检查', () => {
    const chain = newFreshChain();
    mineRewardBlock(chain, walletA.address, 100);

    const tx1 = createSignedTx(walletA, walletB.address, 60, 2, '第一笔');
    const r1 = chain.addPendingTransaction(tx1, false);
    if (!r1.success) return `第一笔交易失败: ${r1.error}`;

    // 此时 pending 中有 60+2=62 待花费，可用余额 = 100-62 = 38
    // 第二笔只能花 ≤ 38
    const tx2 = createSignedTx(walletA, walletB.address, 38, 0, '刚好花完');
    const r2 = chain.addPendingTransaction(tx2, false);

    const tx3 = createSignedTx(walletA, walletB.address, 1, 0, '超额');
    const r3 = chain.addPendingTransaction(tx3, false);

    return (r2.success === true &&
            r3.success === false &&
            r3.error.includes('余额不足')) ? true
        : `r2=${r2.success}, r3=${r3.success}, r3.error=${r3.error}`;
});

// ============================================================
//  第8组: SYSTEM 交易与备注交易不进入 addPendingTransaction
// ============================================================
console.log('');
console.log('============================================================');
console.log('  第8组: 特殊交易类型处理');
console.log('============================================================');

test('SYSTEM 交易跳过签名验证，addPendingTransaction 成功', () => {
    const chain = newFreshChain();
    const rewardTx = new Transaction('SYSTEM', walletA.address, 50, 0, 'Mining Reward');
    const result = chain.addPendingTransaction(rewardTx, true);
    return result.success === true ? true
        : `SYSTEM 交易被拒绝: ${result.error}`;
});

test('备注交易（from 为空）跳过签名验证，addPendingTransaction 成功', () => {
    const chain = newFreshChain();
    const noteTx = new Transaction('', 'NOTE', 0, 0, '备注消息');
    const result = chain.addPendingTransaction(noteTx, true);
    return result.success === true ? true
        : `备注交易被拒绝: ${result.error}`;
});

// ============================================================
//  输出结果
// ============================================================
console.log('');
console.log('============================================================');
console.log(`  测试结果: ${passCount} / ${testCount} 通过`);
console.log('============================================================');

if (passCount === testCount) {
    console.log('\n🎉 所有测试通过！P2P 交易池广播功能工作正常。\n');
    process.exit(0);
} else {
    console.log(`\n⚠️  有 ${testCount - passCount} 个测试失败，请检查。\n`);
    process.exit(1);
}