// ============================================================
// Merkle 树单元测试
// 运行方式: node test/test_merkle.js
// ============================================================
const crypto = require('crypto');
const { Block, Transaction, calculateMerkleRoot } = require('../src/core');

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

// ============================================================
// 辅助：创建确定性 Transaction（覆盖随机 id/timestamp）
// ============================================================
function createDeterministicTx(from, to, amount, fee = 0, note = '', seed = '') {
    const tx = new Transaction(from, to, amount, fee, note);
    // 覆盖随机生成的 id 为确定性值
    tx.id = crypto.createHash('sha256')
        .update(`tx:${from}:${to}:${amount}:${fee}:${note}:${seed}`)
        .digest('hex');
    tx.timestamp = '2025-01-01T00:00:00.000Z';
    return tx;
}

// ============================================================
// 辅助：创建确定性 JSON 交易对象（模拟从文件/P2P 加载的普通对象）
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
        timestamp: '2025-01-01T00:00:00.000Z'
    };
}

// 预期的空列表 Merkle 根（sha256('')）
const EMPTY_MERKLE_ROOT = crypto.createHash('sha256').update('').digest('hex');

console.log('============================================================');
console.log('  第1组: calculateMerkleRoot 基础测试');
console.log('============================================================');

test('空交易列表返回 sha256("") 的确定性值', () => {
    const root = calculateMerkleRoot([]);
    return root === EMPTY_MERKLE_ROOT ? true : `预期 ${EMPTY_MERKLE_ROOT}，实际 ${root}`;
});

test('null/undefined 也返回 sha256("")', () => {
    const r1 = calculateMerkleRoot(null);
    const r2 = calculateMerkleRoot(undefined);
    return (r1 === EMPTY_MERKLE_ROOT && r2 === EMPTY_MERKLE_ROOT) ? true : 'null/undefined 未返回空哈希';
});

test('单笔交易返回该交易的 calculateHash() 值', () => {
    const tx = createDeterministicTx('Alice', 'Bob', 100, 1, '付款');
    const root = calculateMerkleRoot([tx]);
    const expected = tx.calculateHash();
    return root === expected ? true : `预期 ${expected}，实际 ${root}`;
});

test('两笔交易: Merkle 根 = hash(hash(tx1) + hash(tx2))', () => {
    const tx1 = createDeterministicTx('Alice', 'Bob', 100, 0, '', '1');
    const tx2 = createDeterministicTx('Bob', 'Charlie', 50, 0, '', '2');
    const root = calculateMerkleRoot([tx1, tx2]);

    const h1 = tx1.calculateHash();
    const h2 = tx2.calculateHash();
    const expected = crypto.createHash('sha256').update(h1 + h2).digest('hex');
    return root === expected ? true : `预期 ${expected}，实际 ${root}`;
});

test('三笔交易（奇数）: 复制第三笔凑偶 → 四笔', () => {
    const tx1 = createDeterministicTx('A', 'B', 10, 0, '', '1');
    const tx2 = createDeterministicTx('B', 'C', 20, 0, '', '2');
    const tx3 = createDeterministicTx('C', 'D', 30, 0, '', '3');
    const root = calculateMerkleRoot([tx1, tx2, tx3]);

    // 期望：hash( hash(h1+h2) + hash(h3+h3) )
    const h1 = tx1.calculateHash();
    const h2 = tx2.calculateHash();
    const h3 = tx3.calculateHash();
    const h12 = crypto.createHash('sha256').update(h1 + h2).digest('hex');
    const h33 = crypto.createHash('sha256').update(h3 + h3).digest('hex');
    const expected = crypto.createHash('sha256').update(h12 + h33).digest('hex');
    return root === expected ? true : `预期 ${expected}，实际 ${root}`;
});

test('四笔交易: 标准二叉树结构', () => {
    const txs = [1, 2, 3, 4].map(i =>
        createDeterministicTx('A', 'B', i * 10, 0, '', String(i))
    );
    const root = calculateMerkleRoot(txs);

    const hs = txs.map(tx => tx.calculateHash());
    const h12 = crypto.createHash('sha256').update(hs[0] + hs[1]).digest('hex');
    const h34 = crypto.createHash('sha256').update(hs[2] + hs[3]).digest('hex');
    const expected = crypto.createHash('sha256').update(h12 + h34).digest('hex');
    return root === expected ? true : `预期 ${expected}，实际 ${root}`;
});

console.log('');
console.log('============================================================');
console.log('  第2组: 确定性测试 — 相同输入 = 相同输出');
console.log('============================================================');

test('相同输入两次调用结果一致', () => {
    const txs = [
        createDeterministicTx('A', 'B', 10, 0, '', '1'),
        createDeterministicTx('C', 'D', 20, 0, '', '2')
    ];
    const r1 = calculateMerkleRoot(txs);
    const r2 = calculateMerkleRoot(txs);
    return r1 === r2 ? true : `两次结果不一致: ${r1} vs ${r2}`;
});

test('不同输入产生不同的 Merkle 根', () => {
    const txs1 = [createDeterministicTx('A', 'B', 10, 0, '', '1')];
    const txs2 = [createDeterministicTx('A', 'B', 20, 0, '', '2')];
    const r1 = calculateMerkleRoot(txs1);
    const r2 = calculateMerkleRoot(txs2);
    return r1 !== r2 ? true : '不同输入却产生了相同 Merkle 根';
});

test('交易顺序影响 Merkle 根', () => {
    const txA = createDeterministicTx('A', 'B', 10, 0, '', '1');
    const txB = createDeterministicTx('C', 'D', 20, 0, '', '2');
    const rootAB = calculateMerkleRoot([txA, txB]);
    const rootBA = calculateMerkleRoot([txB, txA]);
    return rootAB !== rootBA ? true : '交换顺序后 Merkle 根应不同（防篡改）';
});

console.log('');
console.log('============================================================');
console.log('  第3组: 普通 JSON 对象兼容性');
console.log('============================================================');

test('普通 JSON 对象（无 calculateHash 方法）也能计算 Merkle 根', () => {
    const tx1 = createDeterministicJsonTx('A', 'B', 10, 0, 'test', '1');
    const root = calculateMerkleRoot([tx1]);
    // 验证返回的是合法 hex 哈希（64 字符）
    return /^[0-9a-f]{64}$/.test(root) ? true : `不是合法哈希: ${root}`;
});

test('Transaction 实例与 JSON 对象内容相同时 Merkle 根一致', () => {
    const seed = 'same-content';
    const txInstance = createDeterministicTx('X', 'Y', 99, 1, '测试', seed);
    const txJson = createDeterministicJsonTx('X', 'Y', 99, 1, '测试', seed);

    const rootInstance = calculateMerkleRoot([txInstance]);
    const rootJson = calculateMerkleRoot([txJson]);

    return rootInstance === rootJson ? true
        : `Instance=${rootInstance}, JSON=${rootJson}，应一致`;
});

test('混合 Transaction 实例和 JSON 对象也能正确计算', () => {
    const tx1 = createDeterministicTx('A', 'B', 10, 0, '', '1');
    const tx2 = createDeterministicJsonTx('C', 'D', 20, 0, '', '2');
    const root = calculateMerkleRoot([tx1, tx2]);
    // 不应抛异常，应返回合法哈希
    return /^[0-9a-f]{64}$/.test(root) ? true : `不是合法哈希: ${root}`;
});

console.log('');
console.log('============================================================');
console.log('  第4组: Block 集成 — Merkle 根自动计算');
console.log('============================================================');

test('Block 构造后自动计算 merkleRoot', () => {
    const txs = [
        createDeterministicTx('Alice', 'Bob', 100, 0, '付款', '1'),
        createDeterministicTx('Bob', 'Charlie', 50, 0, '找零', '2')
    ];
    const block = new Block(1, '2025-01-01T00:00:00.000Z', txs, '0'.repeat(64));
    return (block.merkleRoot !== null && /^[0-9a-f]{64}$/.test(block.merkleRoot))
        ? true : `merkleRoot 无效: ${block.merkleRoot}`;
});

test('Block 的 merkleRoot 等于 calculateMerkleRoot(transactions)', () => {
    const txs = [
        createDeterministicTx('A', 'B', 10, 0, '', '1'),
        createDeterministicTx('C', 'D', 20, 0, '', '2')
    ];
    const block = new Block(1, '2025-01-01T00:00:00.000Z', txs, '0'.repeat(64));
    const expectedRoot = calculateMerkleRoot(txs);
    return block.merkleRoot === expectedRoot
        ? true : `block=${block.merkleRoot}, expected=${expectedRoot}`;
});

test('updateMerkleRoot 能重新计算', () => {
    const txs = [createDeterministicTx('A', 'B', 10, 0, '', '1')];
    const block = new Block(1, '2025-01-01T00:00:00.000Z', txs, '0'.repeat(64));
    const originalRoot = block.merkleRoot;

    // 添加一笔新交易
    const newTx = createDeterministicTx('C', 'D', 20, 0, '', '2');
    block.transactions.push(newTx);
    block.updateMerkleRoot();

    const newRoot = block.merkleRoot;
    const expectedRoot = calculateMerkleRoot(block.transactions);
    return (originalRoot !== newRoot && newRoot === expectedRoot)
        ? true : `original=${originalRoot}, new=${newRoot}, expected=${expectedRoot}`;
});

console.log('');
console.log('============================================================');
console.log('  第5组: 篡改检测 — Merkle 根变化');
console.log('============================================================');

test('篡改交易金额后 Merkle 根变化', () => {
    const tx = createDeterministicTx('Alice', 'Bob', 100, 0, '', '1');
    const originalRoot = calculateMerkleRoot([tx]);

    // 篡改金额
    tx.amount = 999;
    const tamperedRoot = calculateMerkleRoot([tx]);

    return originalRoot !== tamperedRoot ? true : '篡改金额后 Merkle 根未变化！';
});

test('篡改交易备注后 Merkle 根变化', () => {
    const tx = createDeterministicTx('Alice', 'Bob', 100, 0, '原始备注', '1');
    const originalRoot = calculateMerkleRoot([tx]);

    tx.note = '篡改后的备注';
    const tamperedRoot = calculateMerkleRoot([tx]);

    return originalRoot !== tamperedRoot ? true : '篡改备注后 Merkle 根未变化！';
});

test('区块中任意交易被篡改 → block hash 变化（通过 Merkle 根传导）', () => {
    const txs = [
        createDeterministicTx('A', 'B', 50, 0, '', '1'),
        createDeterministicTx('C', 'D', 30, 0, '', '2')
    ];
    const block = new Block(1, '2025-01-01T00:00:00.000Z', txs, '0'.repeat(64));
    const originalHash = block.hash;

    // 篡改交易金额
    block.transactions[1].amount = 999999;
    block.updateMerkleRoot();
    const newHash = block.calculateHash();

    return originalHash !== newHash
        ? true : '篡改交易后 block hash 应变化（Merkle 根传导失败）';
});

console.log('');
console.log('============================================================');
console.log(`  测试结果: ${passCount} / ${testCount} 通过`);
console.log('============================================================');

if (passCount === testCount) {
    console.log('\n🎉 所有 Merkle 树测试通过！\n');
    process.exit(0);
} else {
    console.log(`\n⚠️  有 ${testCount - passCount} 个测试失败，请检查。\n`);
    process.exit(1);
}