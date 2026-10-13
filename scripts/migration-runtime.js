const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const dotenv = require('dotenv');
const WebSocket = require('ws');
const { verifiedManifest, assertOffline, atomicWrite, fileHash } = require('./migrate-chain');
const { Blockchain } = require('../src/blockchain/blockchain');
const { Consensus } = require('../src/consensus');
const { toUnits } = require('../src/protocol');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function assert(condition, message) { if (!condition) throw new Error(message); }
function save(plan, name, value) { atomicWrite(path.join(plan.directory, name), JSON.stringify(value, null, 2) + '\n'); }
function activePlan(filename) {
    const plan = verifiedManifest(path.resolve(filename));
    assert(plan.root === fs.realpathSync(path.join(__dirname, '..')), '只能启动本项目的迁移节点');
    const journal = JSON.parse(fs.readFileSync(path.join(plan.directory, 'journal.json'), 'utf8'));
    assert(journal.status === 'applied', '迁移尚未完整应用');
    assert(fileHash(path.join(plan.root, '.env')) === plan.files.at(-1).candidateHash, '迁移后配置发生变化，需重新审计');
    return plan;
}
async function request(port, endpoint, body) {
    const response = await fetch(`http://127.0.0.1:${port}/api${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(body === undefined ? 10000 : 120000)
    });
    assert(response.ok, `${port}${endpoint}: HTTP ${response.status}`);
    return response.json();
}
function stateDigest(state) {
    const sorted = map => [...map].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, String(value)]);
    return digest({ balances: sorted(state.balances), nonces: sorted(state.nonces), ids: [...state.ids].sort(),
        locked: state.locked.map(item => ({ ...item, amount: String(item.amount) })).sort((a, b) => a.height - b.height || a.address.localeCompare(b.address)) });
}
async function inspectNode(plan, port) {
    const validator = new Consensus(Blockchain.prototype.createGenesisBlock(), plan.consensus);
    const [overview, exported, storage, addresses, pool] = await Promise.all([
        request(port, '/blockchain'), request(port, '/storage/export'), request(port, '/storage/status'),
        request(port, '/addresses'), request(port, '/mempool')
    ]);
    const evaluation = validator.evaluate(exported.chain);
    assert(evaluation.valid, `${port} 完整链验证失败：${evaluation.error}`);
    const tip = exported.chain.at(-1);
    assert(overview.port === port && exported.port === port && path.resolve(storage.file) === plan.files.find(entry => entry.port === port).source, `${port} 节点身份或存储路径不匹配`);
    assert(overview.isValid && overview.chain.at(-1).hash === tip.hash && overview.stats.chainWork === String(evaluation.work), `${port} API 链状态不匹配`);
    assert(exported.consensusHash === plan.consensusHash && new Consensus(Blockchain.prototype.createGenesisBlock(), exported.consensus).fingerprint === plan.consensusHash, `${port} 共识参数不一致`);
    assert(exported.chain[plan.cutoff].hash === plan.checkpoint, `${port} 历史检查点不匹配`);
    const disk = JSON.parse(fs.readFileSync(storage.file, 'utf8'));
    assert(disk.consensusHash === plan.consensusHash && disk.chain.at(-1).hash === tip.hash && validator.evaluate(disk.chain).valid, `${port} 持久化链不匹配`);
    const rebuilt = validator.rebuildPool(evaluation, pool.transactions);
    assert(rebuilt.rejected.length === 0, `${port} 交易池包含无效交易`);
    const expectedAddresses = new Set(exported.chain.flatMap(block => block.transactions.flatMap(tx => [tx.from, tx.to])).filter(a => a && a !== 'SYSTEM' && a !== 'NOTE'));
    const rows = addresses.addresses.filter(row => row.address !== 'SYSTEM' && row.address !== 'NOTE');
    assert(rows.length === expectedAddresses.size && new Set(rows.map(row => row.address)).size === rows.length, `${port} 地址列表不完整`);
    for (const row of rows) {
        assert(expectedAddresses.has(row.address), `${port} 未知地址`);
        for (const currency of ['STC', 'cBTC', 'cETH']) assert(toUnits(row.balances[currency]) === (evaluation.state.balances.get(row.address + ':' + currency) || 0n), `${port} 余额不一致：${row.address}:${currency}`);
        const locked = evaluation.state.locked.filter(item => item.address === row.address).reduce((sum, item) => sum + item.amount, 0n);
        assert(toUnits(row.lockedRewards) === locked, `${port} 锁定奖励不一致`);
        const nonce = await request(port, '/nonce/' + encodeURIComponent(row.address));
        assert(nonce.confirmedNonce === (evaluation.state.nonces.get(row.address) || 0)
            && nonce.nextNonce === (rebuilt.state.nonces.get(row.address) || 0), `${port} nonce 不一致`);
    }
    return { port, height: tip.index, hash: tip.hash, version: tip.version, chainWork: String(evaluation.work),
        consensusHash: exported.consensusHash, stateHash: stateDigest(evaluation.state), addressesChecked: rows.length,
        connectedNodes: overview.stats.connectedNodes, pendingIds: pool.transactions.map(tx => tx.id).sort(),
        persisted: true, chain: exported.chain };
}
async function verifyRuntime(plan, minimumHeight = plan.cutoff) {
    const nodes = await Promise.all(plan.ports.map(port => inspectNode(plan, port)));
    const first = nodes[0];
    assert(nodes.every(node => node.height >= minimumHeight && node.hash === first.hash && node.stateHash === first.stateHash
        && node.chainWork === first.chainWork && node.connectedNodes >= plan.ports.length - 1), '三节点尚未同步或互联');
    assert(nodes.every(node => digest(node.pendingIds) === digest(first.pendingIds)), '三节点交易池不一致');
    return { status: 'passed', id: plan.id, checkedAt: new Date().toISOString(), checkpoint: plan.checkpoint,
        nodes: nodes.map(({ chain, ...node }) => node), checks: ['live_identity', 'strict_chain', 'checkpoint', 'consensus',
            'local_chainwork', 'balances', 'locked_rewards', 'nonces', 'persisted_chain', 'peer_connections', 'mempool'] };
}
async function waitForRuntime(plan, minimumHeight) {
    const deadline = Date.now() + 45000;
    let lastError;
    while (Date.now() < deadline) {
        try { return await verifyRuntime(plan, minimumHeight); } catch (error) { lastError = error; }
        await delay(500);
    }
    throw lastError;
}
async function startNodes(plan) {
    await assertOffline(plan.ports);
    const validator = new Consensus(Blockchain.prototype.createGenesisBlock(), plan.consensus);
    for (const entry of plan.files.filter(entry => entry.port)) {
        const saved = JSON.parse(fs.readFileSync(entry.source, 'utf8'));
        assert(saved.consensusHash === plan.consensusHash && validator.evaluate(saved.chain).valid, '启动前链验证失败');
    }
    const logDirectory = path.join(plan.directory, 'logs'); fs.mkdirSync(logDirectory, { recursive: true });
    const configured = dotenv.parse(fs.readFileSync(path.join(plan.root, '.env')));
    const children = [], startedAt = new Date().toISOString(), runId = Date.now();
    try {
        for (const port of plan.ports) {
            const stdout = path.join(logDirectory, `${port}-${runId}.out.log`), stderr = path.join(logDirectory, `${port}-${runId}.err.log`);
            const out = fs.openSync(stdout, 'wx'), err = fs.openSync(stderr, 'wx');
            let child;
            try {
                child = spawn(process.execPath, [path.join(plan.root, 'src', 'server.js')], {
                    cwd: plan.root, detached: true, windowsHide: true, stdio: ['ignore', out, err],
                    env: { ...process.env, ...configured, PORT: String(port),
                        SEED_PEERS: plan.ports.filter(other => other !== port).map(other => `ws://127.0.0.1:${other}`).join(',') }
                });
            } finally { fs.closeSync(out); fs.closeSync(err); }
            children.push({ child, port, pid: child.pid, stdout, stderr });
            await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        }
        const verification = await waitForRuntime(plan, plan.cutoff);
        const runtime = { id: plan.id, startedAt, executable: process.execPath, root: plan.root,
            processes: children.map(({ child, ...entry }) => entry) };
        if (fs.existsSync(path.join(plan.directory, 'runtime.json'))) fs.copyFileSync(path.join(plan.directory, 'runtime.json'), path.join(plan.directory, `runtime-${runId}.json`));
        save(plan, 'runtime.json', runtime); save(plan, 'verification-startup.json', verification);
        for (const entry of children) entry.child.unref();
        return { status: 'started', processes: runtime.processes.map(({ port, pid }) => ({ port, pid })), height: verification.nodes[0].height };
    } catch (error) {
        // These handles identify only children created by this invocation.
        for (const entry of children) { if (entry.child.pid) entry.child.kill(); }
        throw error;
    }
}
async function sendRejectedHistory(port, chain, transactions) {
    await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
        const timer = setTimeout(() => { ws.terminate(); reject(new Error(`${port} 重放验证超时`)); }, 15000);
        const finish = error => { clearTimeout(timer); ws.terminate(); error ? reject(error) : resolve(); };
        ws.on('error', finish);
        ws.on('open', () => {
            for (const transaction of transactions) ws.send(JSON.stringify({ type: 'TRANSACTION', transaction }));
            ws.send(JSON.stringify({ type: 'CHAIN', chain }));
            // WebSocket ordering makes PONG a barrier after the previous handlers.
            ws.send(JSON.stringify({ type: 'PING' }));
        });
        ws.on('message', data => { if (JSON.parse(data).type === 'PONG') finish(); });
    });
}
async function activateAndVerify(plan) {
    const before = await verifyRuntime(plan); save(plan, 'verification-before.json', before);
    assert(before.nodes.every(node => node.height === plan.cutoff && node.pendingIds.length === 0), '首块验收必须从恢复高度、空交易池开始');
    const old = JSON.parse(fs.readFileSync(plan.files[0].backup, 'utf8')).chain;
    const minerAddress = old[plan.cutoff].transactions.find(tx => tx.from === 'SYSTEM').to;
    console.log(JSON.stringify({ event: 'mining_first_v2', height: plan.cutoff + 1, minerAddress }));
    const mined = await request(plan.ports[0], '/mine', { minerAddress, data: 'v2 migration activation' });
    assert(mined.success && mined.block.version === 2 && mined.block.index === plan.cutoff + 1, '首个 v2 区块生成失败');
    const after = await waitForRuntime(plan, plan.cutoff + 1);
    assert(after.nodes.every(node => node.hash === mined.block.hash && node.version === 2), '首个 v2 区块未一致同步');
    const final = await rejectHistory(plan);
    final.firstV2 = { height: mined.block.index, hash: mined.block.hash, minerAddress, miningTime: mined.miningTime };
    final.checks.push('first_v2_pow', 'live_three_node_propagation');
    save(plan, 'verification-activation.json', final); return final;
}
async function rejectHistory(plan) {
    const before = await verifyRuntime(plan, plan.cutoff + 1);
    const old = JSON.parse(fs.readFileSync(plan.files[0].backup, 'utf8')).chain;
    const validator = new Consensus(Blockchain.prototype.createGenesisBlock(), plan.consensus);
    const confirmedIds = new Set(old.slice(0, plan.cutoff + 1).flatMap(block => block.transactions.map(tx => tx.id)));
    const confirmed = old[plan.cutoff + 1].transactions.filter(tx => tx.from && tx.from !== 'SYSTEM' && tx.amount > 0 && confirmedIds.has(tx.id));
    const recovery = JSON.parse(fs.readFileSync(path.join(plan.directory, 'recovery-transactions.json'), 'utf8'));
    const samples = [...confirmed, recovery.find(entry => entry.signatureValid && entry.currency === 'STC')?.transaction].filter(Boolean);
    assert(!validator.evaluate(old).valid, '旧链意外有效，拒绝执行重放测试');
    const current = (await request(plan.ports[0], '/storage/export')).chain;
    assert(samples.length >= 2 && validator.rebuildPool(validator.evaluate(current), samples).pending.length === 0, '重放样本必须已确定无效');
    for (const port of plan.ports) await sendRejectedHistory(port, old, samples);
    const final = await verifyRuntime(plan, plan.cutoff + 1);
    assert(final.nodes.every((node, index) => node.hash === before.nodes[index].hash
        && node.stateHash === before.nodes[index].stateHash && digest(node.pendingIds) === digest(before.nodes[index].pendingIds)), '旧链或重放交易改变了节点状态');
    final.replayRejected = { transactionIds: samples.map(tx => tx.id), oldHeight: old.at(-1).index, ports: plan.ports };
    final.checks.push('old_chain_rejection', 'old_transaction_rejection');
    save(plan, 'verification-replay.json', final); return final;
}
if (require.main === module) {
    (async () => {
        const [mode, filename] = process.argv.slice(2), plan = activePlan(filename);
        if (mode === 'start') return startNodes(plan);
        if (mode === 'activate') return activateAndVerify(plan);
        if (mode === 'replay') return rejectHistory(plan);
        if (mode === 'verify') {
            const report = await verifyRuntime(plan, plan.cutoff + 1); save(plan, 'verification-latest.json', report); return report;
        }
        throw new Error('用法：node scripts/migration-runtime.js start|activate|verify|replay <manifest.json>');
    })().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { activePlan, inspectNode, verifyRuntime, stateDigest };
