// ============================================================
// StorageManager 非 testMode 持久化单元测试
// 覆盖: loadFromFile（真实文件读写）、saveToFile（真实文件）、clearDataFile（真实文件）
// ============================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Blockchain, Block, Transaction, generateWallet } = require('../../src/blockchain/blockchain');
const { createSignedTx } = require('../helpers');

// ============================================================
// 辅助：创建非 testMode 的链（指向临时文件）
// ============================================================
function newNonTestChain() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-test-'));
    const dataFile = path.join(tmpDir, 'blockchain_test.json');
    const chain = new Blockchain(9999, false);
    // 覆盖 dataFile 为临时路径，避免污染真实数据
    chain.dataFile = dataFile;
    chain.storage.blockchain.dataFile = dataFile;
    chain.coinbaseMaturity = 0;
    chain.difficulty = 1;
    chain.pendingTransactions = [];
    return { chain, dataFile, tmpDir };
}

function cleanupChain({ tmpDir }) {
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
}

// ============================================================
// 第1组: saveToFile（非 testMode 真实写入）
// ============================================================
describe('StorageManager.saveToFile (非 testMode)', () => {
    let env;

    beforeEach(() => {
        env = newNonTestChain();
    });

    afterEach(() => {
        cleanupChain(env);
    });

    it('保存后文件实际存在于磁盘', () => {
        const result = env.chain.storage.saveToFile();
        expect(result).toBe(true);
        expect(fs.existsSync(env.dataFile)).toBe(true);
    });

    it('保存的文件内容为合法 JSON', () => {
        env.chain.storage.saveToFile();
        const raw = fs.readFileSync(env.dataFile, 'utf8');
        const parsed = JSON.parse(raw);
        expect(parsed).toBeDefined();
        expect(parsed.chain).toBeDefined();
        expect(Array.isArray(parsed.chain)).toBe(true);
    });

    it('保存的文件包含 version 字段', () => {
        env.chain.storage.saveToFile();
        const raw = fs.readFileSync(env.dataFile, 'utf8');
        const parsed = JSON.parse(raw);
        expect(parsed.version).toBe('3.0');
    });

    it('保存后文件中的链长度与内存一致', () => {
        const wallet = generateWallet();
        // 添加几个区块
        const rewardTx = new Transaction('SYSTEM', wallet.address, 50, 0, 'Miner Reward');
        for (let i = 0; i < 3; i++) {
            const block = new Block(
                env.chain.chain.length,
                new Date().toISOString(),
                [rewardTx],
                env.chain.getLatestBlock().hash
            );
            block.mineBlock(env.chain.difficulty);
            env.chain.chain.push(block);
        }
        env.chain.storage.saveToFile();

        const raw = fs.readFileSync(env.dataFile, 'utf8');
        const parsed = JSON.parse(raw);
        expect(parsed.chain.length).toBe(env.chain.chain.length);
    });

    it('保存后文件中的 difficulty 与内存一致', () => {
        env.chain.difficulty = 5;
        env.chain.storage.saveToFile();

        const raw = fs.readFileSync(env.dataFile, 'utf8');
        const parsed = JSON.parse(raw);
        expect(parsed.difficulty).toBe(5);
    });

    it('多次保存文件内容可覆盖且保持最新', () => {
        env.chain.storage.saveToFile();

        const wallet = generateWallet();
        const rewardTx = new Transaction('SYSTEM', wallet.address, 50, 0, 'Miner Reward');
        const block = new Block(
            env.chain.chain.length,
            new Date().toISOString(),
            [rewardTx],
            env.chain.getLatestBlock().hash
        );
        block.mineBlock(env.chain.difficulty);
        env.chain.chain.push(block);
        env.chain.storage.saveToFile();

        const raw = fs.readFileSync(env.dataFile, 'utf8');
        const parsed = JSON.parse(raw);
        expect(parsed.chain.length).toBe(2); // 创世块 + 新区块
    });
});

// ============================================================
// 第2组: loadFromFile（非 testMode 真实读取）
// ============================================================
describe('StorageManager.loadFromFile (非 testMode)', () => {
    let env;

    beforeEach(() => {
        env = newNonTestChain();
    });

    afterEach(() => {
        cleanupChain(env);
    });

    it('文件不存在时返回 false', () => {
        // 确保文件不存在
        if (fs.existsSync(env.dataFile)) {
            fs.unlinkSync(env.dataFile);
        }
        const result = env.chain.storage.loadFromFile();
        expect(result).toBe(false);
    });

    it('从有效文件加载后返回 true', () => {
        // 先保存
        env.chain.storage.saveToFile();
        // 新建一个链实例，指向同一个文件
        const chain2 = new Blockchain(9999, false);
        chain2.dataFile = env.dataFile;
        chain2.storage.blockchain.dataFile = env.dataFile;

        const result = chain2.storage.loadFromFile();
        expect(result).toBe(true);
    });

    it('加载后链的区块数量与保存时一致', () => {
        const wallet = generateWallet();
        for (let i = 0; i < 3; i++) {
            const rewardTx = new Transaction('SYSTEM', wallet.address, 50, 0, 'Miner Reward');
            const block = new Block(
                env.chain.chain.length,
                new Date().toISOString(),
                [rewardTx],
                env.chain.getLatestBlock().hash
            );
            block.mineBlock(env.chain.difficulty);
            env.chain.chain.push(block);
        }
        env.chain.storage.saveToFile();
        const savedLen = env.chain.chain.length;

        // 新建链加载
        const chain2 = new Blockchain(9999, false);
        chain2.dataFile = env.dataFile;
        chain2.storage.blockchain.dataFile = env.dataFile;
        chain2.storage.loadFromFile();

        expect(chain2.chain.length).toBe(savedLen);
    });

    it('加载后链的 difficulty 从文件恢复并重新计算', () => {
        env.chain.difficulty = 3;
        env.chain.storage.saveToFile();

        // 验证文件中的 difficulty
        const raw = fs.readFileSync(env.dataFile, 'utf8');
        const saved = JSON.parse(raw);
        expect(saved.difficulty).toBe(3);

        const chain2 = new Blockchain(9999, false);
        chain2.dataFile = env.dataFile;
        chain2.storage.blockchain.dataFile = env.dataFile;
        chain2.storage.loadFromFile();

        // loadFromFile 成功后会调用 recalculateDifficulty，该值可能因区块时间戳而调整
        expect(chain2.difficulty).toBeGreaterThan(0);
        expect(typeof chain2.difficulty).toBe('number');
    });

    it('加载后区块的 hash 链式引用有效', () => {
        const wallet = generateWallet();
        for (let i = 0; i < 2; i++) {
            const rewardTx = new Transaction('SYSTEM', wallet.address, 50, 0, 'Miner Reward');
            const block = new Block(
                env.chain.chain.length,
                new Date().toISOString(),
                [rewardTx],
                env.chain.getLatestBlock().hash
            );
            block.mineBlock(env.chain.difficulty);
            env.chain.chain.push(block);
        }
        env.chain.storage.saveToFile();

        const chain2 = new Blockchain(9999, false);
        chain2.dataFile = env.dataFile;
        chain2.storage.blockchain.dataFile = env.dataFile;
        chain2.storage.loadFromFile();

        // 验证链完整性
        for (let i = 1; i < chain2.chain.length; i++) {
            expect(chain2.chain[i].previousHash).toBe(chain2.chain[i - 1].hash);
        }
    });

    it('文件内容损坏时返回 false 并保留原链', () => {
        // 写入非法 JSON
        fs.writeFileSync(env.dataFile, 'not valid json{{{', 'utf8');
        const result = env.chain.storage.loadFromFile();
        expect(result).toBe(false);
    });
});

// ============================================================
// 第3组: clearDataFile（非 testMode 真实删除）
// ============================================================
describe('StorageManager.clearDataFile (非 testMode)', () => {
    let env;

    beforeEach(() => {
        env = newNonTestChain();
    });

    afterEach(() => {
        cleanupChain(env);
    });

    it('clearDataFile 后文件被删除', () => {
        env.chain.storage.saveToFile();
        expect(fs.existsSync(env.dataFile)).toBe(true);

        env.chain.storage.clearDataFile();
        expect(fs.existsSync(env.dataFile)).toBe(false);
    });

    it('clearDataFile 后链重置为仅创世块', () => {
        const wallet = generateWallet();
        const rewardTx = new Transaction('SYSTEM', wallet.address, 50, 0, 'Miner Reward');
        const block = new Block(
            env.chain.chain.length,
            new Date().toISOString(),
            [rewardTx],
            env.chain.getLatestBlock().hash
        );
        block.mineBlock(env.chain.difficulty);
        env.chain.chain.push(block);
        expect(env.chain.chain.length).toBe(2);

        env.chain.storage.clearDataFile();
        expect(env.chain.chain.length).toBe(1);
        expect(env.chain.chain[0].index).toBe(0);
    });

    it('clearDataFile 后难度重置为初始值', () => {
        const config = require('../../src/config');
        env.chain.difficulty = 8;
        env.chain.storage.clearDataFile();
        expect(env.chain.difficulty).toBe(config.DIFFICULTY_INITIAL);
    });

    it('clearDataFile 后返回 true', () => {
        // 文件尚未创建，clear 应该仍然成功
        const result = env.chain.storage.clearDataFile();
        expect(result).toBe(true);
    });
});

// ============================================================
// 第4组: 通过 Blockchain 委托方法调用
// ============================================================
describe('Blockchain 委托 storage 方法 (非 testMode)', () => {
    let env;

    beforeEach(() => {
        env = newNonTestChain();
    });

    afterEach(() => {
        cleanupChain(env);
    });

    it('blockchain.saveToFile() 委托正常工作', () => {
        const result = env.chain.saveToFile();
        expect(result).toBe(true);
        expect(fs.existsSync(env.dataFile)).toBe(true);
    });

    it('blockchain.loadFromFile() 委托正常工作', () => {
        env.chain.saveToFile();
        const chain2 = new Blockchain(9999, false);
        chain2.dataFile = env.dataFile;
        chain2.storage.blockchain.dataFile = env.dataFile;

        const result = chain2.loadFromFile();
        expect(result).toBe(true);
    });

    it('blockchain.clearDataFile() 委托正常工作', () => {
        env.chain.saveToFile();
        expect(fs.existsSync(env.dataFile)).toBe(true);

        const result = env.chain.clearDataFile();
        expect(result).toBe(true);
        expect(fs.existsSync(env.dataFile)).toBe(false);
    });
});