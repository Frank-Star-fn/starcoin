const fs = require('fs');
const os = require('os');
const path = require('path');
const { Blockchain, Block, Transaction, generateWallet } = require('../../src/blockchain/blockchain');
const { prepareMigration, verifiedManifest, applyMigration, rollbackMigration, fileHash, atomicWrite, envCandidate } = require('../../scripts/migrate-chain');
const { rehearseMigration } = require('../../scripts/rehearse-migration');

const params = { initialDifficulty: 1, difficultyMin: 0, coinbaseMaturity: 0, difficultyAdjustInterval: 1000000, activationHeight: 1, legacyCheckpointHash: '' };
const ports = [31000, 31001, 31002], offline = async () => {};
function fixture(root) {
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=keep-this-value\nPORT=3000\nPROTOCOL_ACTIVATION_HEIGHT=1\n');
    const alice = generateWallet(), chain = [Blockchain.prototype.createGenesisBlock()];
    function append(transfers = []) {
        const tx = new Transaction('SYSTEM', alice.address, 50, 0, 'Miner Reward');
        const block = new Block(chain.length, new Date(Date.now() - 20000 + chain.length * 1000).toISOString(), [tx, ...transfers], chain.at(-1).hash);
        block.mineBlock(1); chain.push(block);
    }
    append(); append();
    const transfer = new Transaction(alice.address, 'bob', 10, 1); transfer.signTransaction(alice.privateKey, alice.publicKey);
    append([transfer]); append([transfer]);
    for (const port of ports) fs.writeFileSync(path.join(root, 'data', 'blockchain_' + port + '.json'), JSON.stringify({ version: '3.0', chain }));
    return { alice, chain, transfer };
}
describe('离线迁移、备份与恢复保护', () => {
    let root, data;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-migration-')); data = fixture(root); });
    afterEach(() => {
        const resolved = path.resolve(root);
        if (!resolved.startsWith(path.join(os.tmpdir(), 'stc-migration-'))) throw new Error('Invalid cleanup target');
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    function prepare() { return prepareMigration({ root, ports, cutoff: 2, consensus: params, id: 'test-migration' }); }
    function manifest(plan) { return path.join(plan.directory, 'manifest.json'); }
    it('准备阶段只写备份、候选和报告，不改原始文件', () => {
        const before = ports.map(p => fileHash(path.join(root, 'data', 'blockchain_' + p + '.json'))), env = fileHash(path.join(root, '.env'));
        const plan = prepare();
        expect(plan.counts.recoveryTransactions).toBe(1); expect(plan.consensus.activationHeight).toBe(3);
        ports.forEach((p, i) => expect(fileHash(path.join(root, 'data', 'blockchain_' + p + '.json'))).toBe(before[i]));
        expect(fileHash(path.join(root, '.env'))).toBe(env);
        expect(JSON.parse(fs.readFileSync(plan.files[0].candidate, 'utf8')).chain).toEqual(JSON.parse(JSON.stringify(data.chain.slice(0, 3))));
        expect(verifiedManifest(manifest(plan)).checkpoint).toBe(data.chain[2].hash);
    });
    it('恢复清单排除保留历史中的重复支付，后续交易等待重新签名', () => {
        const plan = prepare(), entries = JSON.parse(fs.readFileSync(path.join(plan.directory, 'recovery-transactions.json'), 'utf8'));
        expect(entries).toHaveLength(1); expect(entries[0].transaction).toEqual(JSON.parse(JSON.stringify(data.transfer)));
        expect(entries[0].status).toBe('wallet_resign_required'); expect(entries[0].signatureValid).toBe(true);
        expect(JSON.parse(fs.readFileSync(plan.files[0].candidate, 'utf8')).pendingTransactions).toEqual([]);
    });
    it('候选配置保留其他设置，统一完整共识参数', () => {
        const plan = prepare(), env = fs.readFileSync(plan.files.at(-1).candidate, 'utf8');
        expect(env).toContain('SECRET=keep-this-value'); expect(env).toContain('PORT=3000');
        expect(env).toContain('PROTOCOL_ACTIVATION_HEIGHT=3'); expect(env).toContain('DIFFICULTY_INITIAL=1');
    });
    it('共识配置重复项被合并，避免最后一个旧值覆盖迁移值', () => {
        const env = envCandidate('CHAIN_ID=old\nCHAIN_ID=older\n', { chainId: 'new' });
        expect(env.match(/^CHAIN_ID=/gm)).toHaveLength(1); expect(env).toContain('CHAIN_ID=new');
    });
    it('节点保留历史不同则拒绝生成可执行计划', () => {
        const file = path.join(root, 'data', 'blockchain_31001.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        saved.chain[2].hash = 'a'.repeat(64); fs.writeFileSync(file, JSON.stringify(saved));
        expect(() => prepare()).toThrow(/历史不一致/);
    });
    it('保留前缀也必须验证签名、账本和 PoW', () => {
        for (const port of ports) {
            const file = path.join(root, 'data', 'blockchain_' + port + '.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            saved.chain[1].transactions[0].amount = 500; fs.writeFileSync(file, JSON.stringify(saved));
        }
        expect(() => prepare()).toThrow(/审计失败/);
    });
    it('源文件在准备后变化则拒绝切换', async () => {
        const plan = prepare(); fs.appendFileSync(path.join(root, '.env'), 'CHANGED=1\n');
        await expect(applyMigration(manifest(plan), { ensureOffline: offline })).rejects.toThrow(/发生变化/);
        expect(fileHash(plan.files[0].source)).toBe(plan.files[0].sourceHash);
    });
    it.each(['backup', 'candidate'])('%s 校验失败则拒绝切换', async kind => {
        const plan = prepare(); fs.appendFileSync(plan.files[0][kind], ' ');
        await expect(applyMigration(manifest(plan), { ensureOffline: offline })).rejects.toThrow(/校验值/);
        expect(fileHash(plan.files[0].source)).toBe(plan.files[0].sourceHash);
    });
    it('清单不能把写入目标改为项目外文件', () => {
        const plan = prepare(); plan.files[0].source = path.join(os.tmpdir(), 'outside.json');
        fs.writeFileSync(manifest(plan), JSON.stringify(plan)); expect(() => verifiedManifest(manifest(plan))).toThrow(/路径/);
    });
    it('运行中节点会阻止切换', async () => {
        const plan = prepare(); await expect(applyMigration(manifest(plan), { ensureOffline: async () => { throw new Error('节点仍在运行'); } })).rejects.toThrow(/运行/);
        expect(fileHash(plan.files[0].source)).toBe(plan.files[0].sourceHash);
    });
    it('写入中途失败会恢复全部原文件，包括配置', async () => {
        const plan = prepare(); let writes = 0;
        await expect(applyMigration(manifest(plan), { ensureOffline: offline, write: (file, bytes) => {
            if (++writes === 2) throw new Error('disk failure'); atomicWrite(file, bytes);
        } })).rejects.toThrow(/已恢复/);
        for (const entry of plan.files) expect(fileHash(entry.source)).toBe(entry.sourceHash);
        expect(JSON.parse(fs.readFileSync(path.join(plan.directory, 'journal.json'), 'utf8')).status).toBe('rolled_back');
    });
    it('切换后三节点均能严格启动，原交易在状态查询中标记回滚', async () => {
        const plan = prepare(); expect((await applyMigration(manifest(plan), { ensureOffline: offline })).status).toBe('applied');
        for (const port of ports) {
            const chain = new Blockchain(port, false, { dataFile: path.join(root, 'data', 'blockchain_' + port + '.json'), consensus: plan.consensus });
            expect(chain.isChainValid()).toBe(true); expect(chain.chain).toHaveLength(3);
            expect(chain.getTransactionStatus(data.transfer.id).status).toBe('reverted');
            expect(chain.getBalance(data.alice.address)).toBe(100);
        }
    });
    it('重复执行不会再次覆盖迁移后数据', async () => {
        const plan = prepare(); await applyMigration(manifest(plan), { ensureOffline: offline });
        await expect(applyMigration(manifest(plan), { ensureOffline: offline })).rejects.toThrow(/已执行/);
    });
    it('切换后尚未产生新数据时可以恢复原始备份', async () => {
        const plan = prepare(); await applyMigration(manifest(plan), { ensureOffline: offline });
        expect((await rollbackMigration(manifest(plan), { ensureOffline: offline })).status).toBe('rolled_back');
        for (const entry of plan.files) expect(fileHash(entry.source)).toBe(entry.sourceHash);
    });
    it('迁移后产生新块，恢复工具拒绝无审计覆盖', async () => {
        const plan = prepare(); await applyMigration(manifest(plan), { ensureOffline: offline });
        const chain = new Blockchain(31000, false, { dataFile: plan.files[0].source, consensus: plan.consensus }); chain.mineBlock('new-miner');
        await expect(rollbackMigration(manifest(plan), { ensureOffline: offline })).rejects.toThrow(/产生新数据/);
    });
    it('旧代币发行与代币支付只进入核对清单，不恢复为有效余额', () => {
        for (const port of ports) {
            const file = path.join(root, 'data', 'blockchain_' + port + '.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            const issuance = new Transaction('SYSTEM', data.alice.address, 5, 0, 'airdrop', 'cBTC');
            const tx = new Transaction(data.alice.address, 'bob', 1, 0, '', 'cBTC'); tx.signTransaction(data.alice.privateKey, data.alice.publicKey);
            saved.chain[3].transactions.push(issuance, tx); fs.writeFileSync(file, JSON.stringify(saved));
        }
        const plan = prepare(), records = JSON.parse(fs.readFileSync(path.join(plan.directory, 'recovery-transactions.json'), 'utf8'));
        expect(records.find(entry => entry.currency === 'cBTC').status).toBe('issuance_review_required');
        expect(plan.counts.issuanceRecords).toBe(3); // Independently generated issuance records retain their origins.
    });
    it('真实文件副本演练包含签名转账、同步和重启', async () => {
        const plan = prepare(), result = await rehearseMigration(manifest(plan));
        expect(result.status).toBe('passed'); expect(result.isolated).toBe(true);
        for (const entry of plan.files) expect(fileHash(entry.source)).toBe(entry.sourceHash);
    });
});
