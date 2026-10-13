const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ethers = require('ethers');
function setup(abi, method, json) {
    const elements = new Map(Object.entries({ evmAbi: { value: JSON.stringify(abi) }, evmMethod: { value: method },
        evmArgs: { value: json }, evmGas: { value: '1000000' }, evmValue: { value: '0' },
        evmContract: { value: '0x1111111111111111111111111111111111111111' } }));
    const context = vm.createContext({ ethers, document: { getElementById: id => elements.get(id) } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/front/evm.js'), 'utf8'), context);
    vm.runInContext('globalThis.formState = evmUi', context);
    return { context, elements };
}
describe('Contract parameter entry', () => {
    it('encodes integers above Number precision from individual fields without rounding', () => {
        const abi = ['function set(uint256 value)'], ctx = setup(abi, 'set(uint256)', '[]');
        ctx.context.formState.parameterFields.evmArgs = { json: { open: false }, fields: [{ input: { value: '9007199254740993' }, param: { type: 'uint256', name: 'value' } }] };
        const tx = ctx.context.evmTxOptions(false);
        expect(new ethers.Interface(abi).decodeFunctionData('set', tx.data)[0]).toBe(9007199254740993n);
    });
    it.each([true, false])('keeps array JSON intact when the advanced panel is open=%s', open => {
        const abi = ['function sum(uint256[] values)'], ctx = setup(abi, 'sum(uint256[])', '[["1","2","9007199254740993"]]');
        ctx.context.formState.parameterFields.evmArgs = { json: { open }, complex: true, fields: [] };
        const tx = ctx.context.evmTxOptions(false);
        expect(Array.from(new ethers.Interface(abi).decodeFunctionData('sum', tx.data)[0])).toEqual([1n, 2n, 9007199254740993n]);
    });
    it('rejects rounded numeric JSON and explains an empty target address', () => {
        const ctx = setup(['function set(uint256 value)'], 'set(uint256)', '[9007199254740992]');
        expect(() => ctx.context.evmTxOptions(false)).toThrow(/大整数请用引号/);
        ctx.elements.get('evmArgs').value = '["42"]'; ctx.elements.get('evmContract').value = '';
        expect(() => ctx.context.evmTxOptions(false)).toThrow(/请先部署/);
    });
});
