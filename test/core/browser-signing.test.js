const crypto = require('crypto');
const walletCrypto = require('../../src/front/wallet-crypto');
const { generateWallet, importWalletFromPem, mnemonicToWallet, Transaction } = require('../../src/core');
const { createHdContext, deriveAddresses } = require('../../src/hd-wallet');
const { EvmTransaction } = require('../../src/evm/transaction');
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('browser crypto compatibility', () => {
    it('imports generated PKCS#8 keys and emits keys accepted by the existing node', () => {
        for (let i = 0; i < 5; i++) {
            const old = generateWallet(), local = walletCrypto.importPem(old.privateKey);
            expect(local.publicKey).toBe(old.publicKey); expect(local.address).toBe(old.address);
            const emitted = walletCrypto.walletFromRaw(walletCrypto.rawFromPem(old.privateKey));
            expect(importWalletFromPem(emitted.privateKey).address).toBe(old.address);
        }
        const wrong = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
        expect(() => walletCrypto.importPem(wrong.privateKey)).toThrow(/secp256k1/);
    });
    it.each(['', '密码 é'])('preserves legacy addresses, HD fingerprints and paths with password %s', passphrase => {
        const legacy = walletCrypto.legacyWallet(phrase, passphrase), expected = mnemonicToWallet(phrase, passphrase);
        expect(legacy.address).toBe(expected.address); expect(legacy.publicKey).toBe(expected.publicKey);
        const local = walletCrypto.hdDerive({ mnemonic: phrase, passphrase, startIndex: 3, count: 3 });
        const old = deriveAddresses(createHdContext(phrase, passphrase), 3, 3);
        expect(local.root).toEqual(old.root);
        expect(local.wallets.map(w => [w.address, w.publicKey, w.index, w.path])).toEqual(old.wallets.map(w => [w.address, w.publicKey, w.index, w.path]));
    });
    it('signs exact decimal native transfers and binds every field', () => {
        const wallet = generateWallet();
        const tx = walletCrypto.signNative(wallet.privateKey, { chainId: 'test', to: 'a'.repeat(32), amount: '0.00000001', fee: '0.00000002', nonce: 3, currency: 'cBTC', note: '测试' });
        expect(Transaction.fromJSON(tx).isValid()).toBe(true);
        for (const value of [{ ...tx, nonce: 4 }, { ...tx, amount: '0.1' }, { ...tx, chainId: 'other' }, { ...tx, to: 'b'.repeat(32) }]) expect(Transaction.fromJSON(value).isValid()).toBe(false);
        expect(JSON.stringify(tx)).not.toContain('PRIVATE KEY'); expect(tx.privateKey).toBeUndefined();
    });
    it('signs historical EVM bridge envelopes using the existing signature and hash rules', () => {
        const wallet = generateWallet(), address = '0x' + 'a'.repeat(40);
        const tx = walletCrypto.signEnvelope(wallet.privateKey, { chainId: 'test', kind: 'deposit', to: 'EVM:' + address, evmAddress: address, amount: '1.00000001', nonce: 0 });
        expect(EvmTransaction.fromJSON(tx).isValid()).toBe(true);
        expect(EvmTransaction.fromJSON({ ...tx, amount: '2' }).isValid()).toBe(false);
    });
    it('preserves bounded HD recovery and never derives outside the supported scheme', () => {
        const local = walletCrypto.hdDiscover({ mnemonic: phrase }, () => false);
        expect(local.wallets).toHaveLength(1); expect(local.scanNextIndex).toBe(20); expect(local.stoppedAtGap).toBe(true);
        expect(() => walletCrypto.hdDerive({ mnemonic: phrase, startIndex: 0x80000000 })).toThrow();
        expect(() => walletCrypto.hdDerive({ mnemonic: phrase, scheme: 'other' })).toThrow();
        expect(() => walletCrypto.legacyWallet('not a mnemonic')).toThrow();
    });
});
