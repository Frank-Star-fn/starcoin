const path = require('path');
const { Blockchain } = require('../src/blockchain/blockchain');
const { EvmConsensus } = require('../src/evm/consensus');
const { networkSettings } = require('../src/evm/network');
const { rpcNetworkSettings } = require('../src/evm/rpc-network');
async function prepare() {
    const directory = path.resolve(__dirname, '..', 'data'), native = new Blockchain(undefined, true);
    const evm = networkSettings(native.consensus, directory);
    const consensus = new EvmConsensus(native.createGenesisBlock(), native.consensus.params, evm);
    const rpc = await rpcNetworkSettings(consensus, directory);
    console.log('MetaMask 网络配置：' + path.join(directory, 'metamask-network.json'));
    console.log(JSON.stringify(rpc, null, 2));
    console.log('跨机器节点须复制相同的 evm-network.json 和 metamask-network.json，再重启全部节点。');
}
prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
