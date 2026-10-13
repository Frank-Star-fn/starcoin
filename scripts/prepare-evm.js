// Run once with all network nodes stopped. It audits files and freezes the shared checkpoint.
const path = require('path');
const { Blockchain } = require('../src/blockchain/blockchain');
const { networkSettings } = require('../src/evm/network');
const directory = path.resolve(__dirname, '..', 'data');
const native = new Blockchain(undefined, true);
const settings = networkSettings(native.consensus, directory);
console.log('EVM 网络配置：' + path.join(directory, 'evm-network.json'));
console.log(JSON.stringify(settings, null, 2));
console.log('同一网络的节点须使用相同的 evm-network.json；随后重新启动全部节点。');
