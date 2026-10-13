const fs = require('fs');
const os = require('os');
const path = require('path');
const { newFreshChain } = require('../helpers');
const { generateWallet } = require('../../src/blockchain/blockchain');
const { verifyRuntime } = require('../../scripts/migration-runtime');

describe('迁移验收必须独立核对节点账本与持久化数据', () => {
    let root, plan, responses, chain;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-runtime-'));
        chain = newFreshChain();
        const wallet = generateWallet(); chain.mineBlock(wallet.address);
        const tx = chain.createTransaction(wallet.address, 'recipient', 10, 1, '', 'STC', 0);
        tx.signTransaction(wallet.privateKey, wallet.publicKey); chain.addTransaction(tx); chain.mineBlock(wallet.address);
        const saved = JSON.parse(JSON.stringify({ consensusHash: chain.consensus.fingerprint, chain: chain.chain }));
        plan = { id: 'runtime-test', cutoff: 1, checkpoint: chain.chain[1].hash, consensus: chain.consensus.params,
            consensusHash: chain.consensus.fingerprint, ports: [31000, 31001, 31002], files: [] };
        responses = new Map();
        for (const port of plan.ports) {
            const source = path.join(root, `blockchain_${port}.json`); fs.writeFileSync(source, JSON.stringify(saved));
            plan.files.push({ port, source });
            const api = {
                '/blockchain': { chain: saved.chain, isValid: true, port, stats: { chainWork: String(chain.getChainWork()), connectedNodes: 2 } },
                '/storage/export': { ...saved, consensus: chain.consensus.params, port },
                '/storage/status': { file: source }, '/mempool': { transactions: [] },
                '/addresses': { addresses: chain.getAllAddresses() }
            };
            for (const row of api['/addresses'].addresses) api['/nonce/' + row.address] = {
                confirmedNonce: chain.query.getConfirmedNonce(row.address), nextNonce: chain.query.getAddressNonce(row.address)
            };
            responses.set(port, JSON.parse(JSON.stringify(api)));
        }
        vi.stubGlobal('fetch', vi.fn(async url => {
            const target = new URL(url), data = responses.get(Number(target.port))[target.pathname.slice(4)];
            return { ok: true, json: async () => JSON.parse(JSON.stringify(data)) };
        }));
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        const resolved = path.resolve(root);
        if (!resolved.startsWith(path.join(os.tmpdir(), 'stc-runtime-'))) throw new Error('Invalid cleanup target');
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    it('独立重算余额、nonce、工作量并核对三份文件', async () => {
        const report = await verifyRuntime(plan, 2);
        expect(report.status).toBe('passed'); expect(new Set(report.nodes.map(node => node.stateHash)).size).toBe(1);
        expect(report.nodes.every(node => node.persisted && node.addressesChecked === 2)).toBe(true);
    });
    it('拒绝节点声称的虚假累计工作量', async () => {
        responses.get(31001)['/blockchain'].stats.chainWork = '999999999';
        await expect(verifyRuntime(plan)).rejects.toThrow(/API 链状态/);
    });
    it('拒绝读取另一个项目的数据文件', async () => {
        responses.get(31001)['/storage/status'].file = path.join(root, 'elsewhere.json');
        await expect(verifyRuntime(plan)).rejects.toThrow(/存储路径/);
    });
    it('即使三节点报相同余额，也不能通过虚假账本验收', async () => {
        for (const api of responses.values()) api['/addresses'].addresses.find(row => row.address === 'recipient').balances.STC = 100;
        await expect(verifyRuntime(plan)).rejects.toThrow(/余额不一致/);
    });
    it('检测 API 和落盘文件的分歧', async () => {
        const entry = plan.files[1], saved = JSON.parse(fs.readFileSync(entry.source, 'utf8'));
        saved.chain.pop(); fs.writeFileSync(entry.source, JSON.stringify(saved));
        await expect(verifyRuntime(plan)).rejects.toThrow(/持久化链/);
    });
    it('检测错误的已确认 nonce', async () => {
        responses.get(31002)['/nonce/recipient'].confirmedNonce = 1;
        await expect(verifyRuntime(plan)).rejects.toThrow(/nonce/);
    });
    it('拒绝共识配置相异的节点', async () => {
        responses.get(31002)['/storage/export'].consensus.chainId = 'another-network';
        await expect(verifyRuntime(plan)).rejects.toThrow(/共识参数/);
    });
    it('未完成互联不能算迁移验收通过', async () => {
        responses.get(31000)['/blockchain'].stats.connectedNodes = 0;
        await expect(verifyRuntime(plan)).rejects.toThrow(/互联/);
    });
});
