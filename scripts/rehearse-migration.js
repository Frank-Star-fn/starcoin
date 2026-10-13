const fs = require('fs');
const path = require('path');
const { verifiedManifest } = require('./migrate-chain');
const { Blockchain, generateWallet } = require('../src/blockchain/blockchain');
const { createMessageHandlers } = require('../src/p2p/p2p-message-handlers');

async function rehearseMigration(filename) {
    const plan = verifiedManifest(filename);
    const directory = path.join(plan.directory, 'rehearsal'); fs.mkdirSync(directory);
    const chains = plan.ports.map(port => {
        const source = plan.files.find(entry => entry.port === port), file = path.join(directory, 'blockchain_' + port + '.json');
        fs.copyFileSync(source.candidate, file, fs.constants.COPYFILE_EXCL);
        return new Blockchain(port, false, { dataFile: file, consensus: plan.consensus });
    });
    const wallet = generateWallet(), recipient = generateWallet();
    const network = { broadcast() {}, nodeInfo: {}, nodes: new Set() };
    // These copies have no listeners or external peers. Their blocks are never
    // broadcast to the live network, and ephemeral test keys remain in memory.
    const handlers = chains.slice(1).map(chain => createMessageHandlers({ ...network, nodeInfo: {} }, chain));
    for (let i = 0; i <= plan.consensus.coinbaseMaturity; i++) {
        const block = await chains[0].mineBlockAsync(wallet.address);
        if (block.canceled) throw new Error('演练挖矿失败');
        for (const handler of handlers) handler.handleBlockResponse(JSON.parse(JSON.stringify(block)));
        console.log(JSON.stringify({ event: 'rehearsal_block', height: block.index, version: block.version }));
    }
    const nonce = chains[0].query.getAddressNonce(wallet.address);
    const tx = chains[0].createTransaction(wallet.address, recipient.address, '1', '0.01', 'migration rehearsal', 'STC', nonce);
    tx.signTransaction(wallet.privateKey, wallet.publicKey);
    for (const chain of chains) if (!chain.addPendingTransaction(tx).success) throw new Error('演练交易入池失败');
    if (chains[0].addPendingTransaction(tx).success) throw new Error('重复交易未被拒绝');
    const block = await chains[0].mineBlockAsync(wallet.address);
    for (const handler of handlers) handler.handleChainResponse(JSON.parse(JSON.stringify(chains[0].chain)));
    for (const chain of chains) {
        if (!chain.isChainValid() || chain.getLatestBlock().hash !== block.hash || chain.getBalance(recipient.address) !== 1
            || chain.query.getConfirmedNonce(wallet.address) !== nonce + 1 || chain.pendingTransactions.length !== 0) throw new Error('演练同步或账本不一致');
        const restarted = new Blockchain(0, false, { dataFile: chain.dataFile, consensus: plan.consensus });
        if (!restarted.isChainValid() || restarted.getLatestBlock().hash !== block.hash || restarted.getBalance(recipient.address) !== 1) throw new Error('演练重启验证失败');
        const old = JSON.parse(fs.readFileSync(plan.files[0].backup, 'utf8'));
        if (restarted.replaceChain(old.chain)) throw new Error('旧无效链未被拒绝');
        if (restarted.addPendingTransaction(tx).success) throw new Error('已确认交易可再次入池');
    }
    const report = { status: 'passed', id: plan.id, isolated: true, ports: plan.ports,
        firstV2Height: plan.cutoff + 1, finalHeight: block.index, finalHash: block.hash,
        checks: ['strict_load', 'coinbase_maturity', 'signed_v2_transfer', 'duplicate_rejection',
            'three_node_block_sync', 'three_node_chain_sync', 'balance_and_nonce', 'restart', 'invalid_old_chain_rejection'],
        completedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(plan.directory, 'rehearsal-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    return report;
}
if (require.main === module) rehearseMigration(path.resolve(process.argv[2])).then(report => console.log(JSON.stringify(report)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { rehearseMigration };
