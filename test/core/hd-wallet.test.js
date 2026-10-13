const { BIP32Factory } = require('bip32');
const bip39 = require('bip39');
const ecc = require('tiny-secp256k1');
const { createHdContext, deriveAddress, deriveAddresses, discoverAddresses, HD_BASE_PATH, MAX_INDEX } = require('../../src/hd-wallet');
const { mnemonicToWallet, importWalletFromPem } = require('../../src/core');
const { newFreshChain, createSignedTx } = require('../helpers');

const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const bip32 = BIP32Factory(ecc);

describe('HD derivation and compatibility', () => {
    // Official BIP32 vectors: https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki
    it('matches official vector 1 for mixed hardened and normal derivation', () => {
        const root = bip32.fromSeed(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
        expect(root.toBase58()).toBe('xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi');
        expect(root.derivePath("m/0'/1/2'/2/1000000000").neutered().toBase58())
            .toBe('xpub6H1LXWLaKsWFhvm6RVpEL9P4KfRZSW7abD2ttkWP3SSQvnyA8FSVqNTEcYFgJS2UaFcxupHiYkro49S8yGasTvXEYBVPamhGW6cFJodrTHy');
    });

    it('retains leading zeros from official vector 4', () => {
        const root = bip32.fromSeed(Buffer.from('3ddd5602285899a946114506157c7997e5444528f3003f6134712147db19b678', 'hex'));
        expect(root.derivePath("m/0'/1'").toBase58())
            .toBe('xprv9xJocDuwtYCMNAo3Zw76WENQeAS6WGXQ55RCy7tDJ8oALr4FWkuVoHJeHVAcAqiZLE7Je3vZJHxspZdFHfnBEjHqU5hG1Jaj32dVoS6XLT1');
    });

    it('converts the BIP44 child to the existing PEM, SPKI and address format', () => {
        const context = createHdContext(mnemonic);
        const child = deriveAddress(context, 3);
        const expected = bip32.fromSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`${HD_BASE_PATH}/3`);
        const imported = importWalletFromPem(child.privateKey);
        expect(imported.address).toBe(child.address);
        expect(imported.publicKey).toBe(child.publicKey);
        const actualKey = require('crypto').createPrivateKey(child.privateKey).export({ format: 'jwk' });
        expect(Buffer.from(actualKey.d, 'base64url')).toEqual(Buffer.from(expected.privateKey));
        expect(child.path).toBe("m/44'/1'/0'/0/3");
    });

    it('pins the old mnemonic address and keeps HD independent', () => {
        const legacy = mnemonicToWallet(mnemonic);
        expect(legacy.address).toBe('553b8c8b243fff695d1723a8ae9a55d8');
        expect(deriveAddress(createHdContext(mnemonic), 0).address).not.toBe(legacy.address);
    });

    it('is deterministic across normalization and passphrase restore', () => {
        const first = deriveAddresses(createHdContext(mnemonic, '密码'), 0, 3);
        const restored = deriveAddresses(createHdContext('  ' + mnemonic.toUpperCase().replace(/ /g, '   ') + '  ', '密码'), 0, 3);
        expect(restored).toEqual(first);
        expect(new Set(first.wallets.map(w => w.address)).size).toBe(3);
        expect(first.root.id).not.toBe(createHdContext(mnemonic).root.id);
        expect(first.nextIndex).toBe(3);
    });

    it('accepts 24 words and Unicode-normalized BIP39 passphrases', () => {
        const words = bip39.entropyToMnemonic('ff'.repeat(32));
        expect(deriveAddress(createHdContext(words, '\u00e9'), 0))
            .toEqual(deriveAddress(createHdContext(words, 'e\u0301'), 0));
    });

    it.each([-1, 0.5, '1', null, MAX_INDEX + 1])('rejects invalid index %s', index => {
        expect(() => deriveAddress(createHdContext(mnemonic), index)).toThrow();
    });

    it('bounds batches and validates credentials and schemes', () => {
        const context = createHdContext(mnemonic);
        for (const count of [0, 101, 1.5, '2']) expect(() => deriveAddresses(context, 0, count)).toThrow();
        expect(() => deriveAddresses(context, MAX_INDEX, 2)).toThrow();
        expect(() => createHdContext('invalid words')).toThrow();
        expect(() => createHdContext(mnemonic, 42)).toThrow();
        expect(() => createHdContext(mnemonic, '', 'unknown')).toThrow();
        expect(() => createHdContext(mnemonic, '', undefined, "m/44'/0'/0'/0")).toThrow();
    });

    it('can sign and mine an ordinary transaction from a derived child', () => {
        const chain = newFreshChain();
        const children = deriveAddresses(createHdContext(mnemonic), 0, 2).wallets;
        chain.mineBlock(children[0].address);
        const tx = createSignedTx(children[0], children[1].address, 10, 1);
        expect(tx.isValid()).toBe(true);
        chain.addTransaction(tx);
        chain.mineBlock(children[0].address);
        expect(chain.getBalance(children[1].address)).toBe(10);
    });
});

describe('bounded HD discovery', () => {
    it('resets the gap on used addresses and retains an initial empty address', () => {
        const context = createHdContext(mnemonic);
        const used = new Set([deriveAddress(context, 0).address, deriveAddress(context, 19).address]);
        const result = discoverAddresses(context, address => used.has(address));
        expect(result.wallets.map(w => w.index)).toEqual([0, 19]);
        expect(result.nextIndex).toBe(20);
        expect(result.scanNextIndex).toBe(40);
        expect(result.stoppedAtGap).toBe(true);
    });

    it('resumes beyond a 20-address gap without reusing discovery-only indices', () => {
        const context = createHdContext(mnemonic);
        const used = new Set([deriveAddress(context, 45).address]);
        const first = discoverAddresses(context, address => used.has(address));
        expect(first.wallets.map(w => w.index)).toEqual([0]);
        const second = discoverAddresses(context, address => used.has(address), { startIndex: first.scanNextIndex });
        const third = discoverAddresses(context, address => used.has(address), { startIndex: second.scanNextIndex });
        expect(third.wallets.map(w => w.index)).toEqual([45]);
        expect(third.nextIndex).toBe(46);
        expect(third.scanNextIndex).toBe(66);
    });

    it('reports a bounded scan and index exhaustion', () => {
        const context = createHdContext(mnemonic);
        const result = discoverAddresses(context, () => true, { scanCount: 20 });
        expect(result.wallets).toHaveLength(20);
        expect(result.stoppedAtGap).toBe(false);
        expect(discoverAddresses(context, () => false, { startIndex: MAX_INDEX }).exhausted).toBe(true);
    });
});
