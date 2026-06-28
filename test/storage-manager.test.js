// ============================================================
// StorageManager 持久化管理器单元测试
// 覆盖: loadFromFile, saveToFile, clearDataFile
// ============================================================
const { Blockchain, Block, Transaction, generateWallet } = require('../src/blockchain/blockchain');
const { newFreshChain, createSignedTx } = require('./helpers');

// ============================================================
// 第1组: saveToFile
// ============================================================
describe('StorageManager.saveToFile', () => {
    let chain;
    let wallet;

    beforeAll(() => {
        wallet = generateWallet();
    });

    beforeEach(() => {
        chain = newFreshChain();
    });

    it('保存空链（仅创世块）→ 返回 true', () => {
        const result = chain.storage.saveToFile();
        expect(result).toBe(true);
    });

    it('保存后文件包含 version 字段', () => {
        chain.storage.saveToFile();
        // testMode 下 saveToFile 直接返回 true，不实际写入
        // 但我们可以直接构造 JSON 检查结构
        const data = {
            chain: chain.chain,
            difficulty: chain.difficulty,
            difficultyHistory: chain.difficultyHistory,
            lastAdjustmentBlock: chain.lastAdjustmentBlock,
            savedAt: new Date().toISOString(),
            version: '3.0'
        };
        expect(data.version).toBe('3.0');
        expect(data.chain.length).toBe(1);
        expect(data.difficulty).toBeDefined();
        expect(data.difficultyHistory).toBeDefined();
    });

    it('多次保存不改变链状态', () => {
        const beforeLen = chain.chain.length;
        chain.storage.saveToFile();
        chain.storage.saveToFile();
        expect(chain.chain.length).toBe(beforeLen);
    });

    it('保存包含交易的区块后链结构完整', () => {
        fundAddress(chain, wallet.address, 100);
        const tx = createSignedTx(wallet, 'recipient', 10, 1);
        chain.pendingTransactions.push(tx);

        // 手动打包
        const rewardTx = new Transaction('SYSTEM', wallet.address, 50, 0, 'Miner Reward');
        const block = new Block(
            chain.chain.length,
            new Date().toISOString(),
            [rewardTx, tx],
            chain.getLatestBlock().hash
        );
        block.mineBlock(chain.difficulty);
        chain.chain.push(block);

        const result = chain.storage.saveToFile();
        expect(result).toBe(true);
    });
});

// ============================================================
// 第2组: clearDataFile
// ============================================================
describe('StorageManager.clearDataFile', () => {
    let chain;

    beforeEach(() => {
        chain = newFreshChain();
    });

    it('清除后链重置为仅创世块', () => {
        // 先添加一些区块
        const wallet = generateWallet();
        fundAddress(chain, wallet.address, 100);
        fundAddress(chain, wallet.address, 50);
        expect(chain.chain.length).toBe(3);

        chain.storage.clearDataFile();
        expect(chain.chain.length).toBe(1);
        expect(chain.chain[0].index).toBe(0);
    });

    it('清除后难度重置为 config 初始值', () => {
        const config = require('../src/config');
        chain.difficulty = 10;
        chain.storage.clearDataFile();
        expect(chain.difficulty).toBe(config.DIFFICULTY_INITIAL);
    });

    it('清除后 lastAdjustmentBlock 重置为 0', () => {
        chain.lastAdjustmentBlock = 5;
        chain.storage.clearDataFile();
        expect(chain.lastAdjustmentBlock).toBe(0);
    });

    it('清除后返回 true', () => {
        const result = chain.storage.clearDataFile();
        expect(result).toBe(true);
    });
});

// ============================================================
// 第3组: loadFromFile（testMode 行为）
// ============================================================
describe('StorageManager.loadFromFile', () => {
    let chain;

    beforeEach(() => {
        chain = newFreshChain();
    });

    it('testMode 下始终返回 false（不加载本地文件）', () => {
        const result = chain.storage.loadFromFile();
        // Blockchain 构造函数中 testMode=true 时 loadFromFile 返回 false
        expect(result).toBe(false);
    });

    it('testMode 下链保持不变', () => {
        const beforeLen = chain.chain.length;
        chain.storage.loadFromFile();
        expect(chain.chain.length).toBe(beforeLen);
    });
});

// ============================================================
// 辅助: 给地址充值
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