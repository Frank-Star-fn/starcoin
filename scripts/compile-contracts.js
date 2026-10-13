const fs = require('fs');
const path = require('path');
const solc = require('solc');
const root = path.resolve(__dirname, '..');
const names = ['Counter', 'DemoToken'];
const sources = Object.fromEntries(names.map(name => [name + '.sol', { content: fs.readFileSync(path.join(root, 'contracts', name + '.sol'), 'utf8') }]));
const result = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources,
    settings: { evmVersion: 'shanghai', optimizer: { enabled: true, runs: 200 },
        outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
for (const error of result.errors || []) { if (error.severity === 'error') throw new Error(error.formattedMessage); }
const destination = path.join(root, 'public', 'contracts');
fs.mkdirSync(destination, { recursive: true });
for (const name of names) {
    const compiled = result.contracts[name + '.sol'][name];
    const artifact = { contractName: name, compiler: solc.version(), evmVersion: 'shanghai', abi: compiled.abi,
        bytecode: '0x' + compiled.evm.bytecode.object, constructorArgs: name === 'DemoToken' ? ['1000000000000000000000000'] : [] };
    fs.writeFileSync(path.join(destination, name + '.json'), JSON.stringify(artifact, null, 2) + '\n');
    console.log(name + ': ' + compiled.evm.bytecode.object.length / 2 + ' bytes');
}
