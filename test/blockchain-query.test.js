// ============================================================
// QueryEngine 查询引擎单元测试
// 覆盖: findBlockByIndex, findTransactionById, search
// ============================================================
const { Block, Transaction, generateWallet } = require('../src/core');
const { newFreshChain, createSignedTx } = require('./helpers');

// ============================================================
// 第1组: findBlockByIndex
// ============================================================
describe('findBlockByIndex', () => {
    let chain;

    beforeEach(() => {
        chain = newFreshChain();
    });

    it('索引 0 → 返回创世块', () => {
        const block = chain.findBlockByIndex(0);
        expect(block).not.toBeNull();
        expect(block.index).toBe(0);
    });

    it('有效索引 → 返回对应区块', () => {
        const wallet = generateWallet();
        fundAddress(chain, wallet.address, 100);
        fundAddress(chain, wallet.address, 50);

        const block = chain.findBlockByIndex(1);
        expect(block).not.toBeNull();
        expect(block.index).toBe(1);
    });

    it('负数索引 → 返回 null', () => {
        expect(chain.findBlockByIndex(-1)).toBeNull();
    });

    it('越界索引 → 返回 null', () => {
        expect(chain.findBlockByIndex(999)).toBeNull();
    });

    it('非整数 → 返回 null', () => {
        expect(chain.findBlockByIndex(1.5)).toBeNull();
        expect(chain.findBlockByIndex('0')).toBeNull();
        expect(chain.findBlockByIndex(null)).toBeNull();
        expect(chain.findBlockByIndex(undefined)).toBeNull();
    });
});

// ============================================================
// 第2组: findTransactionById
// ============================================================
describe('findTransactionById', () => {
    let chain;
    let wallet, walletB;
    let transferTxId;

    beforeEach(() => {
        chain = newFreshChain();
        wallet = generateWallet();
        walletB = generateWallet();

        // 创建并打包一笔转账交易
        fundAddress(chain, wallet.address, 200);
        const tx = createSignedTx(wallet, walletB.address, 50, 2, 'query test');
        transferTxId = tx.id;

        const rewardTx = new Transaction('SYSTEM', wallet.address, 50, 0, 'Miner Reward');
        const block = new Block(
            chain.chain.length,
            new Date().toISOString(),
            [rewardTx, tx],
            chain.getLatestBlock().hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);
    });

    it('完整 ID 匹配 → 返回 { block, transaction, confirmations }', () => {
        const result = chain.findTransactionById(transferTxId);
        expect(result).not.toBeNull();
        expect(result.transaction).toBeDefined();
        expect(result.transaction.id).toBe(transferTxId);
        expect(result.block).toBeDefined();
        expect(result.blockIndex).toBeDefined();
        expect(result.confirmations).toBeGreaterThanOrEqual(0);
    });

    it('前缀匹配 → 也能找到', () => {
        const prefix = transferTxId.substring(0, 16);
        const result = chain.findTransactionById(prefix);
        expect(result).not.toBeNull();
        expect(result.transaction.id).toBe(transferTxId);
    });

    it('不存在的 ID → 返回 null', () => {
        const result = chain.findTransactionById('0000000000000000000000000000000000000000000000000000000000000000');
        expect(result).toBeNull();
    });

    it('空字符串/非字符串 → 返回 null', () => {
        expect(chain.findTransactionById('')).toBeNull();
        expect(chain.findTransactionById(null)).toBeNull();
        expect(chain.findTransactionById(undefined)).toBeNull();
    });

    it('confirmations 反映了当前链尾高度与区块索引之差', () => {
        const result = chain.findTransactionById(transferTxId);
        const latestIndex = chain.getLatestBlock().index;
        expect(result.confirmations).toBe(latestIndex - result.blockIndex);
    });

    it('遍历全链找到所有交易（系统奖励交易也能找到）', () => {
        const rewardTxId = chain.chain[1].transactions[0].id;
        const result = chain.findTransactionById(rewardTxId);
        expect(result).not.toBeNull();
        expect(result.transaction.from).toBe('SYSTEM');
    });
});

// ============================================================
// 第3组: search — 数字 → 区块搜索
// ============================================================
describe('search — 区块搜索', () => {
    let chain;

    beforeEach(() => {
        chain = newFreshChain();
        const wallet = generateWallet();
        fundAddress(chain, wallet.address, 100);
        fundAddress(chain, wallet.address, 50);
    });

    it('纯数字 "0" → 返回 type=block, 创世块', () => {
        const result = chain.search('0');
        expect(result.type).toBe('block');
        expect(result.result.block.index).toBe(0);
    });

    it('纯数字 "1" → 返回区块 #1', () => {
        const result = chain.search('1');
        expect(result.type).toBe('block');
        expect(result.result.block.index).toBe(1);
    });

    it('纯数字带事务数统计', () => {
        const result = chain.search('1');
        expect(result.result.transactionCount).toBeGreaterThanOrEqual(1);
        expect(result.result.totalBurnedFees).toBeGreaterThanOrEqual(0);
    });

    it('数字越界 → type=not_found 带提示', () => {
        const result = chain.search('999');
        expect(result.type).toBe('not_found');
        expect(result.result.message).toContain('999');
        expect(result.result.hint).toBeDefined();
    });

    it('负数 → 走其他搜索路径', () => {
        const result = chain.search('-1');
        // 不是纯数字（含负号），不会走区块路径
        expect(result.type).not.toBe('block');
    });
});

// ============================================================
// 第4组: search — 交易ID / 区块hash
// ============================================================
describe('search — 交易ID / 区块hash', () => {
    let chain;
    let wallet, walletB;
    let txId;

    beforeEach(() => {
        chain = newFreshChain();
        wallet = generateWallet();
        walletB = generateWallet();
        fundAddress(chain, wallet.address, 200);

        const tx = createSignedTx(wallet, walletB.address, 30, 1, 'search tx test');
        txId = tx.id;
        const rewardTx = new Transaction('SYSTEM', wallet.address, 50, 0, 'Miner Reward');
        const block = new Block(
            chain.chain.length,
            new Date().toISOString(),
            [rewardTx, tx],
            chain.getLatestBlock().hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);
    });

    it('64 位 hex 交易 ID → type=transaction', () => {
        const result = chain.search(txId);
        expect(result.type).toBe('transaction');
        expect(result.result.transaction.id).toBe(txId);
    });

    it('区块 hash → type=block', () => {
        const blockHash = chain.chain[1].hash;
        const result = chain.search(blockHash);
        expect(result.type).toBe('block');
        expect(result.result.block.hash).toBe(blockHash);
    });

    it('短 hex 前缀匹配交易 → 可能匹配', () => {
        const prefix = txId.substring(0, 10);
        const result = chain.search(prefix);
        // 如果是 32 位 hex 且长度=32，会走地址搜索路径
        // 如果 <32 且 >=6，可能走地址前缀模糊搜索
        // 但如果前缀足够短（<6），走交易 ID
        // 实际上 10 位 hex >=6，但 <32，因此走地址前缀模糊搜索
        // 我们确认它不会报错即可
        expect(result).toBeDefined();
        expect(result.query).toBe(prefix);
    });
});

// ============================================================
// 第5组: search — 地址搜索
// ============================================================
describe('search — 地址搜索', () => {
    let chain;
    let wallet;

    beforeEach(() => {
        chain = newFreshChain();
        wallet = generateWallet();
        fundAddress(chain, wallet.address, 100);
    });

    it('32 位 hex 地址 → type=address', () => {
        const result = chain.search(wallet.address);
        expect(result.type).toBe('address');
        expect(result.result.address).toBe(wallet.address);
        expect(result.result.balance).toBeGreaterThanOrEqual(0);
        expect(result.result.transactionCount).toBeGreaterThanOrEqual(1);
    });

    it('地址搜索含 balance / totalBalance / lockedRewards', () => {
        const result = chain.search(wallet.address);
        expect(result.result).toHaveProperty('balance');
        expect(result.result).toHaveProperty('totalBalance');
        expect(result.result).toHaveProperty('lockedRewards');
        expect(result.result).toHaveProperty('pendingTransactions');
        expect(result.result).toHaveProperty('transactions');
    });

    it('未出现过的地址 → balance=0, transactionCount=0', () => {
        const unusedAddr = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const result = chain.search(unusedAddr);
        expect(result.type).toBe('address');
        expect(result.result.balance).toBe(0);
        expect(result.result.transactionCount).toBe(0);
    });
});

// ============================================================
// 第6组: search — 备注搜索 + 交易池搜索 + 未匹配
// ============================================================
describe('search — 备注 / mempool / 未匹配', () => {
    let chain;
    let wallet, walletB;

    beforeEach(() => {
        chain = newFreshChain();
        wallet = generateWallet();
        walletB = generateWallet();
        fundAddress(chain, wallet.address, 200);

        const tx = createSignedTx(wallet, walletB.address, 30, 1, '特殊关键词_备注搜索');
        const rewardTx = new Transaction('SYSTEM', wallet.address, 50, 0, 'Miner Reward');
        const block = new Block(
            chain.chain.length,
            new Date().toISOString(),
            [rewardTx, tx],
            chain.getLatestBlock().hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);
    });

    it('备注匹配 → type=note', () => {
        const result = chain.search('特殊关键词');
        expect(result.type).toBe('note');
        expect(result.result.transactions.length).toBeGreaterThanOrEqual(1);
    });

    it('备注匹配包含 blockIndex 和 blockHash', () => {
        const result = chain.search('特殊关键词');
        const matchedTx = result.result.transactions[0];
        expect(matchedTx.blockIndex).toBeDefined();
        expect(matchedTx.blockHash).toBeDefined();
    });

    it('pending 交易匹配 → type=mempool', () => {
        // 添加一笔 pending 交易
        const pendingTx = createSignedTx(wallet, walletB.address, 10, 0, 'pending_note_xyz');
        chain.pendingTransactions.push(pendingTx);

        const result = chain.search('pending_note');
        expect(result.type).toBe('mempool');
        expect(result.result.transactions.length).toBeGreaterThanOrEqual(1);
    });

    it('无任何匹配 → type=not_found', () => {
        const result = chain.search('__nonexistent_query_12345__');
        expect(result.type).toBe('not_found');
        expect(result.result.message).toContain('__nonexistent_query_12345__');
    });

    it('空输入 → type=empty', () => {
        const result = chain.search('');
        expect(result.type).toBe('empty');
    });

    it('null → type=empty', () => {
        const result = chain.search(null);
        expect(result.type).toBe('empty');
    });
});

// ============================================================
// 辅助
// ============================================================
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