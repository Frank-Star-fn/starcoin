const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ethers = require('ethers');
const { withdrawalData } = require('../../src/evm/external-transaction');
function setup() {
    const wallet = ethers.Wallet.createRandom(), native = '1'.repeat(32), fingerprint = '2'.repeat(64), elements = new Map();
    const element = id => { if (!elements.has(id)) elements.set(id, { value: '', textContent: '' }); return elements.get(id); };
    const network = { chainId: '0x25d79', rpcConsensusHash: fingerprint };
    const data = withdrawalData({ evm: { chainId: 155001 }, rpcFingerprint: fingerprint }, wallet.address, native, '100000001', '0', String(Math.floor(Date.now() / 1000) + 1800));
    const provider = { request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_accounts') return [wallet.address];
        if (method === 'eth_chainId') return network.chainId;
        if (method === 'eth_signTypedData_v4') { const typed = JSON.parse(params[1]), { EIP712Domain, ...types } = typed.types; return wallet.signTypedData(typed.domain, types, typed.message); }
        throw new Error('Unexpected wallet request: ' + method);
    }) };
    const results = { starcoin_getNetwork: network, starcoin_getWithdrawalTypedData: data,
        starcoin_submitWithdrawal: '0x' + '3'.repeat(64), eth_getTransactionReceipt: null, starcoin_getWithdrawalReceipt: { status: 'unknown' }, eth_getTransactionByHash: null };
    const fetch = vi.fn(async (_url, options) => ({ json: async () => ({ result: results[JSON.parse(options.body).method] }) }));
    const context = vm.createContext({ ethers, fetch, Event: class {}, window: { addEventListener() {}, dispatchEvent() {} },
        document: { getElementById: element }, evmEl: element, evmAction: action => action(), debouncedRefreshAll: vi.fn(),
        state: { wallets: [], selectedWallet: -1 }, evmUi: {}, evmJson: JSON.stringify });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/front/metamask.js'), 'utf8'), context);
    context.provider = provider; context.owner = wallet.address;
    vm.runInContext('mmState.provider = provider; mmState.address = owner;', context);
    element('evmNativeRecipient').value = native; element('evmBridgeAmount').value = '1.00000001';
    return { context, wallet, provider, results, data, fetch, element };
}
describe('MetaMask signing boundary', () => {
    it('constructs the withdrawal schema locally and sends only the intended signed authorization', async () => {
        const ctx = setup(); ctx.data.types = { Permit: [{ name: 'spender', type: 'address' }] };
        ctx.data.domain.verifyingContract = ethers.Wallet.createRandom().address;
        await ctx.context.mmWithdraw();
        const signed = ctx.provider.request.mock.calls.find(([request]) => request.method === 'eth_signTypedData_v4')[0];
        const typed = JSON.parse(signed.params[1]);
        expect(typed.primaryType).toBe('Withdraw'); expect(typed.types.Permit).toBeUndefined();
        expect(typed.domain.verifyingContract).toBeUndefined();
        const submitted = ctx.fetch.mock.calls.map(([_url, input]) => JSON.parse(input.body)).find(input => input.method === 'starcoin_submitWithdrawal').params[0];
        const { EIP712Domain, ...types } = typed.types;
        expect(ethers.verifyTypedData(typed.domain, types, typed.message, submitted.signature)).toBe(ctx.wallet.address);
        expect(submitted.message.nativeAddress).toBe('0x' + '1'.repeat(32)); expect(submitted.message.amountUnits).toBe('100000001');
        expect(JSON.stringify(ctx.fetch.mock.calls)).not.toContain(ctx.wallet.privateKey);
    });
    it('rejects altered recipients before asking the extension to sign', async () => {
        const ctx = setup(); ctx.data.message.nativeAddress = '0x' + '4'.repeat(32);
        await expect(ctx.context.mmWithdraw()).rejects.toThrow(/不一致/);
        expect(ctx.provider.request.mock.calls.some(([input]) => input.method === 'eth_signTypedData_v4')).toBe(false);
    });
    it('rejects writes on another network and distinguishes unknown from pending hashes', async () => {
        const ctx = setup(); ctx.provider.request.mockImplementation(async ({ method }) => method === 'eth_chainId' ? '0x1' : [ctx.wallet.address]);
        await expect(ctx.context.mmGuard()).rejects.toThrow(/切换/);
        expect((await ctx.context.mmReceipt('0x' + '5'.repeat(64))).status).toBe('unknown');
        ctx.results.eth_getTransactionByHash = { blockHash: null };
        expect((await ctx.context.mmReceipt('0x' + '5'.repeat(64))).status).toBe('pending');
    });
});
