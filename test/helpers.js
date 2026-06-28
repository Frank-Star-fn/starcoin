// ============================================================
// 共享测试工具函数
// 供所有 .test.js 文件使用
//
// 第一部分：区块链核心测试辅助
// 第二部分：HTTP API 路由测试 Mock 工具
// ============================================================
'use strict';

const { Blockchain, Block, Transaction, generateWallet } = require('../src/blockchain/blockchain');

// ============================================================
// 第一部分: 区块链核心测试辅助
// ============================================================

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

// ============================================================
// 第二部分: HTTP API 路由测试 Mock 工具
// ============================================================

/**
 * 创建一个 mock Express Response 对象
 * 记录所有调用，便于后续断言
 */
function createMockRes() {
    const calls = { json: [], status: [], write: [], writeHead: [], setHeader: [], end: [] };
    const res = {
        _calls: calls,
        _statusCode: 200,
        _headers: {},
        _body: null,

        status(code) {
            res._statusCode = code;
            calls.status.push(code);
            return res;
        },
        json(body) {
            res._body = body;
            calls.json.push(body);
            return res;
        },
        write(data) {
            calls.write.push(data);
            return res;
        },
        writeHead(statusCode, headers) {
            res._statusCode = statusCode;
            if (headers) Object.assign(res._headers, headers);
            calls.writeHead.push({ statusCode, headers });
            return res;
        },
        setHeader(key, value) {
            res._headers[key] = value;
            calls.setHeader.push({ key, value });
            return res;
        },
        end() {
            calls.end.push(true);
            return res;
        },
        on(event, handler) {
            return res;
        }
    };
    return res;
}

/**
 * 创建一个 mock Express Request 对象
 * @param {object} overrides - 要覆盖的属性
 */
function createMockReq(overrides = {}) {
    return {
        body: {},
        params: {},
        query: {},
        ...overrides
    };
}

/**
 * 创建一个 mock starCoin (Blockchain) 对象
 * 所有方法都是 spy，记录调用参数
 */
function createMockStarCoin(overrides = {}) {
    const calls = {};
    const mock = {
        _calls: calls,

        chain: [{ hash: '0000abcdef1234567890deadbeefcafe' }],
        difficulty: 4,
        targetBlockTime: 10000,
        difficultyHistory: [4, 4, 4, 5, 5, 4, 4, 4, 4, 4],
        pendingTransactions: [],
        coinbaseMaturity: 100,
        miningReward: 50,
        miningAddress: 'TEST_MINER_ADDR',
        dataFile: '/tmp/test_starcoin_data.json',
        freshStart: false,

        isChainValid() { return true; },
        getTotalBurnedFees() { return 0; },
        getRecentBurnedFees(n) { return []; },
        getBalance(addr, includeLocked) { return 100; },
        getLockedRewards(addr) { return 0; },
        getTransactionHistory(addr) { return []; },
        getAllAddresses() { return ['addr1', 'addr2']; },
        getLatestBlock() { return { hash: 'latest_hash', index: 5 }; },
        addTransaction(tx) { return tx; },
        saveToFile() { return true; },
        loadFromFile() { return true; },
        clearDataFile() { return true; },
        mineBlock(minerAddr, data) { return { index: 6, hash: 'new_block_hash', transactions: [], nonce: 12345, timestamp: Date.now(), previousHash: 'prev_hash' }; },
        mineBlockAsync(minerAddr, data, progressCb, cancelCheck) {
            return Promise.resolve({ index: 6, hash: 'new_block_hash', transactions: [], nonce: 12345, timestamp: Date.now(), previousHash: 'prev_hash' });
        },

        ...overrides
    };
    return mock;
}

/**
 * 创建一个 mock p2p 对象
 */
function createMockP2P(overrides = {}) {
    const calls = {};
    const mock = {
        _calls: calls,

        nodeInfo: { id: 'test-node-id', port: 3000 },
        getConnectedCount() { return 0; },
        getNodeUrls() { return []; },
        getAllNodeInfo() { return Promise.resolve([]); },
        getSyncState() {
            return {
                isSyncing: false,
                lastSyncAt: null,
                candidates: []
            };
        },
        syncWithPeers() { return { success: true, message: '同步完成', blocksReceived: 0 }; },
        syncPendingTxs() { return { success: true, message: '交易池同步完成' }; },
        broadcastLatest() {},
        broadcastPendingTxs() {},
        broadcastTransaction(tx) {},
        connectToPeer(url) {},
        disconnectFromPeer(url) { return { success: true, message: `已断开 ${url}` }; },
        updateNodeInfo() {},
        getDiscoveryStatus() {
            return { running: false, interval: 30000, knownNodes: [] };
        },
        startDiscovery() {},
        stopDiscovery() {},
        requestNodeLists() {},

        ...overrides
    };
    return mock;
}

/**
 * 创建一个 spy 函数，记录调用
 */
function createSpy() {
    const fn = function (...args) {
        fn._calls.push(args);
        fn._callCount++;
        return fn._returnValue;
    };
    fn._calls = [];
    fn._callCount = 0;
    fn._returnValue = undefined;
    fn.mockReturnValue = function (val) { fn._returnValue = val; return fn; };
    return fn;
}

module.exports = {
    // 区块链核心测试
    newFreshChain,
    fundAddress,
    createSignedTx,
    // HTTP API 路由测试 Mock
    createMockRes,
    createMockReq,
    createMockStarCoin,
    createMockP2P,
    createSpy,
};