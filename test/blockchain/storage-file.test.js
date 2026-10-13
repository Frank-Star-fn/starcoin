const fs = require('fs');
const os = require('os');
const path = require('path');
const { Blockchain, Block, Transaction, generateWallet } = require('../../src/blockchain/blockchain');
const { Consensus } = require('../../src/consensus');
const { auditChain } = require('../../scripts/audit-chain');

const params = { initialDifficulty: 1, difficultyMin: 0, coinbaseMaturity: 0, difficultyAdjustInterval: 1000000, activationHeight: 1, legacyCheckpointHash: '' };
function legacyHistory() {
    const genesis = new Blockchain(0, true, { consensus: params }).createGenesisBlock();
    const chain = [genesis];
    const alice = generateWallet();
    for (let index = 1; index <= 2; index++) {
        const reward = new Transaction('SYSTEM', alice.address, 50, 0, 'Miner Reward');
        const block = new Block(index, new Date(Date.now() - 10000 + index * 1000).toISOString(), [reward], chain.at(-1).hash);
        block.mineBlock(1); chain.push(block);
    }
    return { chain, alice };
}

describe('原子持久化与启动审计', () => {
    let directory, filename, chain;
    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-security-'));
        filename = path.join(directory, 'chain.json');
        chain = new Blockchain(9999, false, { dataFile: filename, consensus: params });
    });
    afterEach(() => {
        const resolved = path.resolve(directory);
        if (!resolved.startsWith(path.join(os.tmpdir(), 'stc-security-'))) throw new Error('Unexpected cleanup path');
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    function load(options = params) { return new Blockchain(9999, false, { dataFile: filename, consensus: options }); }
    it('缺失文件返回 freshStart，内存保留创世块', () => {
        expect(chain.freshStart).toBe(true); expect(chain.chain).toHaveLength(1);
    });
    it('格式 4.0 包含固定共识摘要，并完整恢复区块', () => {
        chain.mineBlock('miner'); const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
        expect(data.version).toBe('4.0'); expect(data.consensusHash).toBe(chain.consensus.fingerprint);
        const restored = load(); expect(restored.freshStart).toBe(false);
        expect(restored.getLatestBlock().hash).toBe(chain.getLatestBlock().hash); expect(restored.isChainValid()).toBe(true);
    });
    it('保存的难度被篡改也不会覆盖重放计算结果', () => {
        chain.mineBlock('miner'); const data = JSON.parse(fs.readFileSync(filename, 'utf8')); data.difficulty = 30;
        fs.writeFileSync(filename, JSON.stringify(data)); expect(load().difficulty).toBe(1);
    });
    it('启动时重新验证待打包交易并保留完整签名', () => {
        const alice = generateWallet(); chain.mineBlock(alice.address);
        const tx = chain.createTransaction(alice.address, 'bob', 1, 0, '', 'STC', 0);
        tx.signTransaction(alice.privateKey, alice.publicKey); chain.addTransaction(tx); chain.saveToFile();
        const restored = load(); expect(restored.pendingTransactions).toEqual([tx]); expect(restored.pendingTransactions[0].isValid()).toBe(true);
    });
    it('非法的持久化交易池不会被恢复', () => {
        chain.mineBlock('miner'); const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
        data.pendingTransactions = [data.chain[1].transactions[0], null]; fs.writeFileSync(filename, JSON.stringify(data));
        expect(load().pendingTransactions).toHaveLength(0);
    });
    it.each(['json', 'hash', 'merkle', 'signature', 'genesis'])('启动审计拒绝 %s 损坏，保留原文件', type => {
        const alice = generateWallet(); chain.mineBlock(alice.address);
        const tx = chain.createTransaction(alice.address, 'bob', 1, 0, '', 'STC', 0);
        tx.signTransaction(alice.privateKey, alice.publicKey); chain.addTransaction(tx); chain.mineBlock('miner');
        const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (type === 'hash') data.chain[2].hash = 'a'.repeat(64);
        if (type === 'merkle') data.chain[2].merkleRoot = 'a'.repeat(64);
        if (type === 'signature') data.chain[2].transactions[1].signature = 'a'.repeat(64);
        if (type === 'genesis') data.chain[0].transactions[0].amount = 100;
        const original = type === 'json' ? '{bad JSON' : JSON.stringify(data);
        fs.writeFileSync(filename, original);
        expect(() => load()).toThrow(/审计|读取/); expect(fs.readFileSync(filename, 'utf8')).toBe(original);
    });
    it('共识参数改变后拒绝加载现有文件', () => {
        chain.mineBlock('miner'); expect(() => load({ ...params, miningReward: 100 })).toThrow(/共识参数/);
    });
    it('持久化写失败保持原文件、内存链和交易池', () => {
        chain.mineBlock('miner'); const original = fs.readFileSync(filename, 'utf8'), tip = chain.getLatestBlock().hash;
        const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk error'); });
        try { expect(() => chain.mineBlock('miner')).toThrow(/持久化失败/); } finally { spy.mockRestore(); }
        expect(chain.getLatestBlock().hash).toBe(tip); expect(fs.readFileSync(filename, 'utf8')).toBe(original);
        expect(fs.existsSync(filename + '.tmp')).toBe(false);
    });
    it('清除操作原子保存有效的创世状态并清理交易池', () => {
        chain.mineBlock('miner'); expect(chain.clearDataFile()).toBe(true);
        expect(chain.chain).toHaveLength(1); expect(chain.difficulty).toBe(1); expect(chain.pendingTransactions).toHaveLength(0);
        expect(load().chain).toHaveLength(1);
    });
    it('saveToFile 和 loadFromFile 委托仍正常工作', () => {
        chain.mineBlock('miner'); expect(chain.saveToFile()).toBe(true); expect(chain.loadFromFile()).toBe(true);
    });

    it('旧链审计成功生成固定检查点，激活后可以继续挖矿', () => {
        const history = legacyHistory(), report = auditChain(history, params);
        expect(report.valid).toBe(true); expect(report.migration.PROTOCOL_ACTIVATION_HEIGHT).toBe(3);
        fs.writeFileSync(filename, JSON.stringify({ chain: history.chain, version: '3.0' }));
        const migrated = load(report.consensus);
        expect(migrated.chain).toHaveLength(3); expect(migrated.mineBlock('miner').version).toBe(2);
        expect(load(report.consensus).isChainValid()).toBe(true);
    });
    it('旧签名只在检查点之前有效，激活后不能入池', () => {
        const history = legacyHistory(), report = auditChain(history, params);
        fs.writeFileSync(filename, JSON.stringify(history)); const migrated = load(report.consensus);
        const tx = new Transaction(history.alice.address, 'bob', 10); tx.signTransaction(history.alice.privateKey, history.alice.publicKey);
        expect(migrated.addPendingTransaction(tx).success).toBe(false);
    });
    it('激活高度大于 1 必须提供检查点', () => {
        expect(() => new Consensus(chain.createGenesisBlock(), { ...params, activationHeight: 3 })).toThrow(/检查点/);
    });
    it('旧历史检查点不同，拒绝启动并保留文件', () => {
        const history = legacyHistory(), report = auditChain(history, params); fs.writeFileSync(filename, JSON.stringify(history));
        expect(() => load({ ...report.consensus, legacyCheckpointHash: 'a'.repeat(64) })).toThrow(/检查点/);
    });
    it('审计工具不会信任声明的区块哈希或跳过签名', () => {
        const history = legacyHistory(); history.chain[2].hash = 'a'.repeat(64);
        const report = auditChain(history, params); expect(report.valid).toBe(false); expect(report.invalidBlock).toBe(2);
    });
    it('迁移链禁止清除到检查点之前', () => {
        const history = legacyHistory(), report = auditChain(history, params); fs.writeFileSync(filename, JSON.stringify(history));
        const migrated = load(report.consensus); expect(() => migrated.clearDataFile()).toThrow(/检查点/);
    });
});
