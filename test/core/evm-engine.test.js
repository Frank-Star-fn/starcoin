const { EvmEngine, evmAddressFromPem, evmAddressFromPublicKey, WEI_PER_UNIT } = require('../../src/evm/engine');
const { generateWallet } = require('../../src/core');
const context = { index: 1, timestamp: '2026-01-01T00:00:00.000Z', previousHash: '1'.repeat(64) };
// Init code returns a runtime that stores calldata[0] at slot 0 and returns slot 0.
const initCode = '0x6011600c60003960116000f360003560005560005460005260206000f3';

describe('EthereumJS execution adapter', () => {
    it('derives standard EVM addresses from the existing PEM and SPKI keys', () => {
        const wallet = generateWallet();
        expect(evmAddressFromPem(wallet.privateKey)).toBe(evmAddressFromPublicKey(wallet.publicKey));
        expect(evmAddressFromPem(wallet.privateKey)).toMatch(/^0x[0-9a-f]{40}$/);
    });

    it('deploys real bytecode, accounts for gas, and isolates read-only calls', async () => {
        const engine = await EvmEngine.create();
        const wallet = generateWallet();
        const sender = evmAddressFromPem(wallet.privateKey);
        await engine.moveBalance(sender, 100000000n * WEI_PER_UNIT);
        const raw = engine.sign(wallet.privateKey, { nonce: 0, data: initCode });
        const receipt = await engine.execute(raw, context);
        expect(receipt.status).toBe(1);
        expect(receipt.contractAddress).toMatch(/^0x[0-9a-f]{40}$/);
        expect(await engine.balance(sender)).toBe(100000000n * WEI_PER_UNIT - BigInt(receipt.feeWei));
        const root = await engine.root();
        const read = await engine.call({ from: sender, to: receipt.contractAddress, data: '0x' + '00'.repeat(31) + '07' }, context);
        expect(read.returnData).toBe('0x' + '0'.repeat(63) + '7');
        expect(await engine.root()).toBe(root);
        expect(await engine.storage(receipt.contractAddress, '0')).toBe('0x' + '0'.repeat(64));
        const copy = await engine.fork();
        await copy.execute(copy.sign(wallet.privateKey, { nonce: 1, to: receipt.contractAddress, data: '0x' + '00'.repeat(31) + '09' }), context);
        expect(await copy.storage(receipt.contractAddress, '0')).toBe('0x' + '0'.repeat(63) + '9');
        expect(await engine.root()).toBe(root);
    });

    it('preserves nonce and burns gas for REVERT and out-of-gas receipts', async () => {
        const engine = await EvmEngine.create();
        const wallet = generateWallet(), sender = evmAddressFromPem(wallet.privateKey);
        await engine.moveBalance(sender, 100000000n * WEI_PER_UNIT);
        const reverted = await engine.execute(engine.sign(wallet.privateKey, { nonce: 0, data: '0x60006000fd' }), context);
        expect(reverted.status).toBe(0);
        expect(reverted.contractAddress).toBeNull();
        expect(await engine.nonce(sender)).toBe(1n);
        const exhausted = await engine.execute(engine.sign(wallet.privateKey, { nonce: 1, gasLimit: 60000, data: '0x5b600056' }), context);
        expect(exhausted.status).toBe(0);
        expect(exhausted.gasUsed).toBe('60000');
        expect(await engine.nonce(sender)).toBe(2n);
    });

    it('rejects bad signatures, a different chain ID, and excessive gas', async () => {
        const engine = await EvmEngine.create(), other = await EvmEngine.create({ chainId: 155002 });
        const wallet = generateWallet();
        expect(() => engine.decode(other.sign(wallet.privateKey, { nonce: 0 }))).toThrow();
        expect(() => engine.sign(wallet.privateKey, { nonce: 0, gasLimit: 5000001 })).toThrow();
        expect(() => engine.decode('0x1234')).toThrow();
    });
    it('rejects legacy signatures without EIP-155 replay protection', async () => {
        const { createCustomCommon, Mainnet, Hardfork } = require('@ethereumjs/common');
        const { createLegacyTx } = require('@ethereumjs/tx');
        const { bytesToHex } = require('@ethereumjs/util');
        const engine = await EvmEngine.create(), wallet = generateWallet();
        const jwk = require('crypto').createPrivateKey(wallet.privateKey).export({ format: 'jwk' });
        const common = createCustomCommon({ chainId: 155001 }, Mainnet, { hardfork: Hardfork.Homestead });
        const raw = createLegacyTx({ nonce: 0n, gasPrice: 10000000000n, gasLimit: 21000n,
            to: '0x' + '1'.repeat(40) }, { common }).sign(new Uint8Array(Buffer.from(jwk.d, 'base64url')));
        expect(raw.v === 27n || raw.v === 28n).toBe(true);
        expect(() => engine.decode(bytesToHex(raw.serialize()))).toThrow();
    });
});
