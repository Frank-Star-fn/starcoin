const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const dotenv = require('dotenv');
const { Blockchain } = require('../src/blockchain/blockchain');
const { Consensus } = require('../src/consensus');
const { Transaction, effectiveCurrency } = require('../src/core');
const { toUnits } = require('../src/protocol');
const { auditChain } = require('./audit-chain');

const ENV_KEYS = {
    chainId: 'CHAIN_ID', activationHeight: 'PROTOCOL_ACTIVATION_HEIGHT', legacyCheckpointHash: 'LEGACY_CHECKPOINT_HASH',
    initialDifficulty: 'DIFFICULTY_INITIAL', targetBlockTime: 'DIFFICULTY_TARGET_TIME',
    difficultyAdjustInterval: 'DIFFICULTY_ADJUST_INTERVAL', difficultyMin: 'DIFFICULTY_MIN',
    difficultyMax: 'DIFFICULTY_MAX', difficultyStep: 'DIFFICULTY_STEP', miningReward: 'MINING_REWARD',
    coinbaseMaturity: 'MINING_COINBASE_MATURITY', maxTransactions: 'MINING_MAX_TXS_PER_BLOCK', maxFutureSeconds: 'MAX_FUTURE_BLOCK_SECONDS'
};
function sha(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function fileHash(filename) { return fs.existsSync(filename) ? sha(fs.readFileSync(filename)) : null; }
function json(filename, value) { fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
function decimal(value) {
    const negative = value < 0n; const n = negative ? -value : value;
    const fraction = String(n % 100000000n).padStart(8, '0').replace(/0+$/, '');
    return (negative ? '-' : '') + String(n / 100000000n) + (fraction ? '.' + fraction : '');
}
function atomicWrite(filename, data) {
    const temporary = filename + '.migration-' + crypto.randomBytes(8).toString('hex');
    let descriptor;
    try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
        fs.renameSync(temporary, filename);
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}
function confined(root, filename) {
    const resolved = path.resolve(filename), relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('迁移路径超出项目目录');
    // Reject symlinks/junctions, including parents, before copying or replacing files.
    let current = resolved;
    while (current !== root) {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('迁移路径不能经过符号链接');
        current = path.dirname(current);
    }
    return resolved;
}
function envCandidate(original, params) {
    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    const updates = Object.fromEntries(Object.entries(ENV_KEYS).map(([field, name]) => [name, String(params[field])]));
    const used = new Set();
    const lines = original.split(/\r?\n/).map(line => {
        const match = /^\s*(?:export\s+)?([A-Z_]+)\s*=/.exec(line);
        if (!match || !Object.hasOwn(updates, match[1])) return line;
        if (used.has(match[1])) return '# migration removed duplicate ' + match[1];
        used.add(match[1]); return match[1] + '=' + updates[match[1]];
    });
    while (lines.at(-1) === '') lines.pop();
    for (const [name, value] of Object.entries(updates)) if (!used.has(name)) lines.push(name + '=' + value);
    return lines.join(newline) + newline;
}

// Diagnostic view of what the old files counted. It is deliberately not a
// validated balance snapshot and is never used to initialize the recovered chain.
function ledgerView(chain, maturity) {
    const available = new Map(), locked = new Map(), nonces = new Map(), issues = [];
    const tip = chain.at(-1).index;
    const add = (map, address, currency, value) => {
        const key = address + ':' + currency; map.set(key, (map.get(key) || 0n) + value);
    };
    for (const block of chain) for (const tx of block.transactions || []) {
        try {
            const currency = effectiveCurrency(tx), amount = toUnits(tx.amount), fee = toUnits(tx.fee ?? 0);
            if (tx.from) { add(available, tx.from, currency, -amount); add(available, tx.from, 'STC', -fee); }
            if (tx.to) add(tx.from === 'SYSTEM' && block.index + maturity > tip ? locked : available, tx.to, currency, amount);
            if (tx.from && tx.from !== 'SYSTEM' && amount > 0n) nonces.set(tx.from, (nonces.get(tx.from) || 0) + 1);
        } catch (error) { issues.push({ height: block.index, id: tx.id, error: error.message }); }
    }
    return { available, locked, nonces, issues };
}

function prepareMigration({ root, ports = [3000, 3001, 3002], cutoff = 60, id, consensus = {}, mempools = {} }) {
    root = fs.realpathSync(path.resolve(root));
    if (!Number.isSafeInteger(cutoff) || cutoff < 1 || !ports.length || new Set(ports).size !== ports.length
        || ports.some(port => !Number.isSafeInteger(port) || port < 1 || port > 65535)) throw new Error('无效迁移高度或端口');
    id = id || new Date().toISOString().replace(/[-:.]/g, '');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('无效迁移批次标识');
    const directory = confined(root, path.join(root, 'data', 'migrations', id));
    fs.mkdirSync(path.dirname(directory), { recursive: true }); fs.mkdirSync(directory);
    const backupDirectory = path.join(directory, 'backup'), candidateDirectory = path.join(directory, 'candidate');
    fs.mkdirSync(backupDirectory); fs.mkdirSync(candidateDirectory);
    const files = [];
    const sources = ports.map(port => {
        const source = confined(root, path.join(root, 'data', 'blockchain_' + port + '.json'));
        const bytes = fs.readFileSync(source), backup = path.join(backupDirectory, path.basename(source));
        fs.writeFileSync(backup, bytes, { flag: 'wx', mode: 0o600 });
        const entry = { port, source, backup, sourceHash: sha(bytes), backupHash: sha(bytes), candidate: path.join(candidateDirectory, path.basename(source)) };
        files.push(entry); return { port, saved: JSON.parse(bytes.toString('utf8')), entry };
    });
    const envFile = confined(root, path.join(root, '.env'));
    const envBytes = fs.existsSync(envFile) ? fs.readFileSync(envFile) : null;
    const envBackup = path.join(backupDirectory, 'original.env');
    if (envBytes) fs.writeFileSync(envBackup, envBytes, { flag: 'wx', mode: 0o600 });
    const prefix = sources[0].saved.chain.slice(0, cutoff + 1);
    if (prefix.length !== cutoff + 1) throw new Error('原链不足指定保留高度');
    for (const source of sources) {
        const theirs = source.saved.chain.slice(0, cutoff + 1);
        if (theirs.length !== prefix.length || theirs.some((block, index) => block.hash !== prefix[index].hash)) throw new Error('节点的保留历史不一致');
        const audit = auditChain({ chain: theirs }, consensus);
        if (!audit.valid) throw new Error('保留历史审计失败：' + audit.error);
    }
    const audit = auditChain({ chain: prefix }, consensus);
    const params = audit.consensus;
    const validator = new Consensus(Blockchain.prototype.createGenesisBlock(), params);
    const evaluation = validator.evaluate(prefix);
    if (!evaluation.valid) throw new Error(evaluation.error);
    const candidates = new Map(), issuance = new Map(), nodeReports = [];
    function record(map, tx, origin) {
        const serialized = JSON.stringify(Object.keys(tx).sort().map(key => [key, tx[key]]));
        const digest = sha(serialized);
        if (!map.has(tx.id)) map.set(tx.id, { id: tx.id, transaction: tx, digest, origins: [], conflictingRecords: [] });
        const entry = map.get(tx.id); entry.origins.push(origin);
        if (entry.digest !== digest) entry.conflictingRecords.push({ digest, transaction: tx, origin });
    }
    for (const source of sources) {
        const seen = new Map(), duplicates = [];
        let nativeRewardsRolledBack = 0;
        for (const block of source.saved.chain) for (const tx of block.transactions || []) {
            if (seen.has(tx.id)) duplicates.push({ id: tx.id, height: block.index, firstHeight: seen.get(tx.id), type: tx.from === 'SYSTEM' ? 'reward' : tx.from ? 'transfer' : 'note' });
            else seen.set(tx.id, block.index);
            if (block.index <= cutoff) continue;
            if (tx.from === 'SYSTEM') {
                if (effectiveCurrency(tx) === 'STC') nativeRewardsRolledBack++;
                else record(issuance, tx, { port: source.port, height: block.index });
            } else if (tx.from && Number(tx.amount) > 0 && !evaluation.state.ids.has(tx.id)) record(candidates, tx, { port: source.port, height: block.index });
        }
        const captured = mempools[source.port] || [];
        const pending = [...(Array.isArray(source.saved.pendingTransactions) ? source.saved.pendingTransactions : []), ...captured];
        for (const tx of pending) if (tx?.from && tx.from !== 'SYSTEM' && !evaluation.state.ids.has(tx.id)) record(candidates, tx, { port: source.port, height: null, pending: true });
        const before = ledgerView(source.saved.chain, params.coinbaseMaturity), after = ledgerView(prefix, params.coinbaseMaturity);
        const keys = new Set([...before.available.keys(), ...after.available.keys(), ...before.locked.keys(), ...after.locked.keys()]);
        const balances = [...keys].filter(key => !key.startsWith('SYSTEM:') && !key.startsWith('NOTE:')).sort().map(key => {
            const split = key.lastIndexOf(':'); const old = before.available.get(key) || 0n, next = after.available.get(key) || 0n;
            return { address: key.slice(0, split), currency: key.slice(split + 1), oldUnvalidatedBalance: decimal(old),
                recoveredBalance: decimal(next), delta: decimal(next - old),
                oldLockedRewards: decimal(before.locked.get(key) || 0n), recoveredLockedRewards: decimal(after.locked.get(key) || 0n),
                recoveredNonce: evaluation.state.nonces.get(key.slice(0, split)) || 0 };
        });
        nodeReports.push({ port: source.port, oldHeight: source.saved.chain.at(-1).index, recoveredHeight: cutoff,
            rolledBackBlocks: source.saved.chain.length - prefix.length, nativeRewardsRolledBack,
            duplicates, capturedPending: pending.length, balances, oldLedgerIssues: before.issues });
    }
    const recovery = [...candidates.values()].map(entry => {
        const tx = entry.transaction, currency = effectiveCurrency(tx);
        let signatureValid = false; try { signatureValid = Transaction.fromJSON(tx).isValid(); } catch { /* Report malformed records. */ }
        let fundedNow = false; try {
            const amount = toUnits(tx.amount), fee = toUnits(tx.fee ?? 0);
            fundedNow = (evaluation.state.balances.get(tx.from + ':' + currency) || 0n) >= amount + (currency === 'STC' ? fee : 0n)
                && (currency === 'STC' || (evaluation.state.balances.get(tx.from + ':STC') || 0n) >= fee);
        } catch { /* Invalid values are not eligible. */ }
        return { ...entry, currency, signatureValid, fundedNow,
            confirmedNonce: evaluation.state.nonces.get(tx.from) || 0,
            status: entry.conflictingRecords.length ? 'conflicting_record' : !signatureValid ? 'invalid_signature'
                : currency !== 'STC' ? 'issuance_review_required' : 'wallet_resign_required',
            requirements: ['confirm_payment_intent', 'new_v2_signature', 'current_balance_and_nonce_check'] };
    });
    const reverted = recovery.filter(entry => entry.signatureValid && !entry.conflictingRecords.length).map(entry => [entry.id, entry.transaction]).slice(-1000);
    for (const source of sources) {
        const report = nodeReports.find(node => node.port === source.port);
        const snapshot = { version: '4.0', consensusHash: validator.fingerprint, chain: prefix,
            pendingTransactions: [], difficulty: evaluation.difficulty, difficultyHistory: evaluation.difficultyHistory,
            lastAdjustmentBlock: evaluation.lastAdjustmentBlock, revertedTransactions: reverted,
            reorgEvents: [{ depth: report.rolledBackBlocks, commonHeight: cutoff, oldTip: source.saved.chain.at(-1).hash,
                newTip: prefix.at(-1).hash, timestamp: new Date().toISOString(), deep: true, reason: 'audited_migration' }],
            migration: { id, cutoff, checkpoint: prefix.at(-1).hash } };
        json(source.entry.candidate, snapshot); source.entry.candidateHash = fileHash(source.entry.candidate);
    }
    const envEntry = { source: envFile, backup: envBackup, sourceHash: envBytes ? sha(envBytes) : null,
        backupHash: envBytes ? sha(envBytes) : null, candidate: path.join(candidateDirectory, 'migration.env') };
    fs.writeFileSync(envEntry.candidate, envCandidate(envBytes ? envBytes.toString('utf8') : '', params), { flag: 'wx', mode: 0o600 });
    envEntry.candidateHash = fileHash(envEntry.candidate); files.push(envEntry);
    const manifest = { version: 1, id, root, directory, ports, cutoff, checkpoint: prefix.at(-1).hash,
        consensus: params, consensusHash: validator.fingerprint, files, preparedAt: new Date().toISOString(),
        counts: { recoveryTransactions: recovery.length, native: recovery.filter(entry => entry.currency === 'STC').length,
            token: recovery.filter(entry => entry.currency !== 'STC').length, issuanceRecords: issuance.size } };
    json(path.join(directory, 'recovery-transactions.json'), recovery);
    json(path.join(directory, 'issuance-review.json'), [...issuance.values()]);
    json(path.join(directory, 'balance-diff.json'), { warning: '旧余额仅是未验证历史的显示结果，不作为恢复资产的依据', nodes: nodeReports });
    json(path.join(directory, 'manifest.json'), manifest);
    return manifest;
}

function verifiedManifest(filename) {
    const plan = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const root = fs.realpathSync(path.resolve(plan.root));
    if (plan.version !== 1 || !/^[a-zA-Z0-9_-]{1,64}$/.test(plan.id) || !Array.isArray(plan.ports)
        || new Set(plan.ports).size !== plan.ports.length || plan.ports.some(p => !Number.isSafeInteger(p) || p < 1 || p > 65535)) throw new Error('无效迁移清单');
    const directory = confined(root, path.join(root, 'data', 'migrations', plan.id));
    if (plan.directory !== directory || path.resolve(filename) !== path.join(directory, 'manifest.json') || plan.files.length !== plan.ports.length + 1) throw new Error('迁移清单路径不匹配');
    const validator = new Consensus(Blockchain.prototype.createGenesisBlock(), plan.consensus);
    if (validator.fingerprint !== plan.consensusHash || plan.consensus.activationHeight !== plan.cutoff + 1
        || plan.consensus.legacyCheckpointHash !== plan.checkpoint) throw new Error('迁移共识摘要不匹配');
    plan.files.forEach((entry, index) => {
        const isEnv = index === plan.ports.length;
        const basename = isEnv ? '.env' : 'blockchain_' + plan.ports[index] + '.json';
        const source = confined(root, isEnv ? path.join(root, '.env') : path.join(root, 'data', basename));
        const backup = confined(root, path.join(directory, 'backup', isEnv ? 'original.env' : basename));
        const candidate = confined(root, path.join(directory, 'candidate', isEnv ? 'migration.env' : basename));
        if (entry.source !== source || entry.backup !== backup || entry.candidate !== candidate
            || fileHash(backup) !== entry.backupHash || fileHash(candidate) !== entry.candidateHash) throw new Error('迁移文件路径或校验值不匹配');
        if (!isEnv) {
            const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
            const result = validator.evaluate(data.chain);
            if (!result.valid || data.consensusHash !== validator.fingerprint || data.chain.at(-1).hash !== plan.checkpoint || data.chain.length !== plan.cutoff + 1) throw new Error('候选链验证失败');
        } else {
            const parsed = dotenv.parse(fs.readFileSync(candidate));
            if (Object.entries(ENV_KEYS).some(([field, name]) => parsed[name] !== String(plan.consensus[field]))) throw new Error('候选配置不匹配');
        }
    });
    return plan;
}

async function assertOffline(ports) {
    for (const port of ports) await new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port }); socket.setTimeout(1500);
        socket.on('connect', () => { socket.destroy(); reject(new Error('节点仍在运行：' + port)); });
        socket.on('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(new Error('无法确认节点停止：' + port + ' ' + error.code)));
        socket.on('timeout', () => { socket.destroy(); reject(new Error('节点端口检查超时：' + port)); });
    });
}
function restoreFiles(plan, write = atomicWrite) {
    for (const entry of [...plan.files].reverse()) {
        if (entry.sourceHash === null) { if (fs.existsSync(entry.source)) fs.unlinkSync(entry.source); }
        else write(entry.source, fs.readFileSync(entry.backup));
    }
}
async function applyMigration(filename, { ensureOffline = assertOffline, write = atomicWrite } = {}) {
    const plan = verifiedManifest(filename); await ensureOffline(plan.ports);
    const journal = path.join(plan.directory, 'journal.json');
    if (fs.existsSync(journal) && JSON.parse(fs.readFileSync(journal, 'utf8')).status === 'applied') throw new Error('本批次已执行，禁止再次覆盖');
    if (plan.files.some(entry => fileHash(entry.source) !== entry.sourceHash)) throw new Error('准备后原始链或配置发生变化，拒绝切换');
    atomicWrite(journal, JSON.stringify({ status: 'applying', startedAt: new Date().toISOString() }));
    try {
        for (const entry of plan.files) write(entry.source, fs.readFileSync(entry.candidate));
        const parsed = dotenv.parse(fs.readFileSync(path.join(plan.root, '.env')));
        if (Object.entries(ENV_KEYS).some(([field, name]) => parsed[name] !== String(plan.consensus[field]))) throw new Error('切换后的配置不匹配');
        for (const port of plan.ports) {
            const chain = new Blockchain(port, false, { dataFile: path.join(plan.root, 'data', 'blockchain_' + port + '.json'), consensus: plan.consensus });
            if (!chain.isChainValid() || chain.getLatestBlock().hash !== plan.checkpoint) throw new Error('切换后启动审计失败');
        }
        const result = { status: 'applied', id: plan.id, cutoff: plan.cutoff, activationHeight: plan.cutoff + 1,
            checkpoint: plan.checkpoint, completedAt: new Date().toISOString() };
        atomicWrite(journal, JSON.stringify(result, null, 2) + '\n'); return result;
    } catch (error) {
        try { restoreFiles(plan); atomicWrite(journal, JSON.stringify({ status: 'rolled_back', error: error.message })); }
        catch (rollbackError) {
            atomicWrite(journal, JSON.stringify({ status: 'rollback_failed', error: error.message, rollbackError: rollbackError.message }));
            throw new Error('切换失败且备份恢复失败；保持所有节点停止：' + rollbackError.message);
        }
        throw new Error('迁移失败，原始文件已恢复：' + error.message);
    }
}
async function rollbackMigration(filename, { ensureOffline = assertOffline } = {}) {
    const plan = verifiedManifest(filename); await ensureOffline(plan.ports);
    if (plan.files.some(entry => { const value = fileHash(entry.source); return value !== entry.sourceHash && value !== entry.candidateHash; })) throw new Error('切换后已产生新数据，拒绝覆盖；需要另做恢复审计');
    restoreFiles(plan); atomicWrite(path.join(plan.directory, 'journal.json'), JSON.stringify({ status: 'rolled_back', completedAt: new Date().toISOString() }));
    return { status: 'rolled_back', id: plan.id };
}

if (require.main === module) {
    (async () => {
        const [mode, argument, cutoff = '60', id, mempoolDirectory] = process.argv.slice(2);
        if (mode === 'prepare') {
            const mempools = {};
            if (mempoolDirectory) for (const port of [3000, 3001, 3002]) {
                const file = path.join(path.resolve(mempoolDirectory), 'mempool-' + port + '.json');
                if (fs.existsSync(file)) {
                    const captured = JSON.parse(fs.readFileSync(file, 'utf8'));
                    if (!Array.isArray(captured.transactions)) throw new Error('无效交易池导出');
                    mempools[port] = captured.transactions;
                }
            }
            const plan = prepareMigration({ root: argument || path.join(__dirname, '..'), cutoff: Number(cutoff), id, mempools });
            console.log(JSON.stringify({ status: 'prepared', manifest: path.join(plan.directory, 'manifest.json'), checkpoint: plan.checkpoint, counts: plan.counts }));
        } else if (mode === 'apply') console.log(JSON.stringify(await applyMigration(path.resolve(argument))));
        else if (mode === 'rollback') console.log(JSON.stringify(await rollbackMigration(path.resolve(argument))));
        else throw new Error('用法：node scripts/migrate-chain.js prepare <项目目录> [保留高度] [批次ID] | apply <manifest.json> | rollback <manifest.json>');
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { prepareMigration, verifiedManifest, applyMigration, rollbackMigration, assertOffline, envCandidate, fileHash, atomicWrite };
