const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');
const { encryptPrivateKey, decryptPrivateKey } = require('../../src/front/keystore');
const { parseHdBackup, createHdBackup } = require('../../src/front/hd-wallet-state');
const { createHdContext, deriveAddresses, discoverAddresses } = require('../../src/hd-wallet');
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

async function browserHarness() {
    const masterKey = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const storage = new Map();
    const elements = new Map();
    const context = vm.createContext({ console, setTimeout, clearTimeout, crypto: webcrypto,
        confirm: () => true, prompt: () => null,
        localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        getOrCreateMasterKey: async () => masterKey,
        encryptPrivateKey: (text, key) => encryptPrivateKey(text, key || masterKey),
        decryptPrivateKey: (value, key) => decryptPrivateKey(value, key || masterKey),
        renderWallets: vi.fn(), renderTransfer: vi.fn(), refreshSelectedWalletDetails: vi.fn(),
        document: { getElementById: id => {
            if (!elements.has(id)) elements.set(id, { style: {}, value: '', textContent: '', disabled: false });
            return elements.get(id);
        } }
    });
    for (const file of ['app.js', 'hd-wallet-state.js', 'wallet-manager.js', 'hd-wallet-manager.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/front', file), 'utf8'), context);
    }
    context.showMessage = vi.fn();
    context.showForceBackupDialog = vi.fn();
    context.localHdWallet = vi.fn(async (operation, body = {}) => {
        const url = '/api/wallet/hd/' + operation;
        const hd = createHdContext(body.mnemonic || mnemonic, body.passphrase, body.scheme, body.basePath);
        if (url.endsWith('/new')) return { mnemonic, ...deriveAddresses(hd) };
        if (url.endsWith('/import')) return discoverAddresses(hd, () => false, body);
        if (body.indices) {
            const wallets = body.indices.map(i => deriveAddresses(hd, i, 1).wallets[0]);
            return { root: hd.root, wallets, nextIndex: Math.max(...body.indices) + 1 };
        }
        return deriveAddresses(hd, body.startIndex, body.count);
    });
    vm.runInContext('globalThis.walletState = state', context);
    return { context, state: context.walletState, storage, elements, masterKey };
}

describe('HD browser wallet lifecycle', () => {
    it('encrypts root secrets and child keys, survives reload, and never reuses removed indices', async () => {
        const { context, state, storage, masterKey } = await browserHarness();
        await context.generateHdWallet();
        const root = state.hdRoots[0];
        expect(state.wallets[0].type).toBe('hd');
        expect(storage.get('starcoin_wallets')).not.toContain(mnemonic);
        expect(storage.get('starcoin_wallets')).not.toContain('BEGIN PRIVATE KEY');
        expect(await decryptPrivateKey(root.encryptedMnemonic, masterKey)).toBe(mnemonic);
        const firstAddress = state.wallets[0].address;
        await context.addHdAddress(root.id);
        await context.removeWallet(1);
        expect(state.hdRoots[0].nextIndex).toBe(2);
        state.wallets = [];
        state.hdRoots = [];
        await context.loadWallets();
        expect(state.wallets[0].address).toBe(firstAddress);
        await context.addHdAddress(root.id);
        expect(state.wallets.map(w => w.index)).toEqual([0, 2]);
        expect(state.hdRoots[0].nextIndex).toBe(3);
    });

    it('restores names, unused addresses beyond the gap, and a deleted-address high water mark', async () => {
        const original = await browserHarness();
        const hd = createHdContext(mnemonic, 'BIP39 password');
        await original.context.storeHdResult(deriveAddresses(hd), { mnemonic, passphrase: 'BIP39 password' });
        await original.context.storeHdResult(deriveAddresses(hd, 45));
        original.state.wallets[1].label = '未使用的远端地址';
        original.state.hdRoots[0].nextIndex = 48;
        const backup = createHdBackup(original.state.hdRoots[0], mnemonic, 'BIP39 password', original.state.wallets);
        const restored = await browserHarness();
        const file = { size: 1024, text: async () => JSON.stringify(backup) };
        await restored.context.importHdBackupFile({ files: [file], value: 'backup.json' });
        expect(restored.state.wallets.map(w => w.index)).toEqual([0, 45]);
        expect(restored.state.wallets[1].label).toBe('未使用的远端地址');
        expect(restored.state.wallets[1].address).toBe(original.state.wallets[1].address);
        expect(restored.state.hdRoots[0].nextIndex).toBe(48);
        await restored.context.addHdAddress(hd.root.id);
        expect(restored.state.wallets[2].index).toBe(48);
        expect(restored.storage.get('starcoin_wallets')).not.toContain('BIP39 password');
    });

    it('merges repeat imports without duplicate addresses and preserves names', async () => {
        const { context, state } = await browserHarness();
        await context.generateHdWallet();
        state.wallets[0].label = '收款地址';
        await context.storeHdResult(deriveAddresses(createHdContext(mnemonic)), { mnemonic, passphrase: '' });
        expect(state.wallets).toHaveLength(1);
        expect(state.hdRoots).toHaveLength(1);
        expect(state.wallets[0].label).toBe('收款地址');
    });

    it('keeps multiple HD roots independent when removing a whole wallet', async () => {
        const { context, state } = await browserHarness();
        await context.generateHdWallet();
        const firstId = state.hdRoots[0].id;
        const otherMnemonic = require('bip39').entropyToMnemonic('aa'.repeat(16));
        const other = createHdContext(otherMnemonic);
        await context.storeHdResult(deriveAddresses(other), { mnemonic: otherMnemonic, passphrase: '' });
        expect(state.hdRoots).toHaveLength(2);
        const otherAddress = state.wallets[1].address;
        await context.removeHdRoot(firstId);
        expect(state.hdRoots).toHaveLength(1);
        expect(state.hdRoots[0].id).toBe(other.root.id);
        expect(state.wallets).toHaveLength(1);
        expect(state.wallets[0].address).toBe(otherAddress);
        expect(state.selectedWallet).toBe(0);
    });

    it('migrates v1/v2 records while preserving PEM/address and legacy mnemonic mode', async () => {
        const { context, state, storage } = await browserHarness();
        const wallet = require('../../src/core').mnemonicToWallet(mnemonic);
        storage.set('starcoin_wallets', JSON.stringify([{ label: 'old', ...wallet }]));
        await context.loadWallets();
        expect(state.wallets[0].address).toBe(wallet.address);
        expect(state.wallets[0].type).toBe('legacy');
        expect(await context.decryptPrivateKey(state.wallets[0].encryptedMnemonic)).toBe(mnemonic);
        expect(await context.decryptPrivateKey(state.wallets[0].encryptedPrivateKey)).toBe(wallet.privateKey);
        const encryptedMnemonic = await context.encryptPrivateKey(mnemonic);
        storage.set('starcoin_wallets', JSON.stringify({ version: 2,
            wallets: [{ ...state.wallets[0], type: undefined, encryptedMnemonic }], selectedWallet: 0 }));
        await context.loadWallets();
        expect(state.wallets[0].type).toBe('legacy');
        expect(state.hdRoots).toHaveLength(0);
    });

    it('keeps ciphertext on unlock failure and rolls back HD writes on storage failure', async () => {
        const { context, state, storage } = await browserHarness();
        await context.generateHdWallet();
        const saved = storage.get('starcoin_wallets');
        context.decryptPrivateKey = async () => { throw new Error('wrong key'); };
        await context.loadWallets();
        expect(storage.get('starcoin_wallets')).toBe(saved);
        expect(state.hdRoots).toHaveLength(1);
        const nextIndex = state.hdRoots[0].nextIndex;
        context.localStorage.setItem = () => { throw new Error('quota exceeded'); };
        await expect(context.storeHdResult(deriveAddresses(createHdContext(mnemonic), 1))).rejects.toThrow('quota');
        expect(state.hdRoots[0].nextIndex).toBe(nextIndex);
        expect(state.wallets).toHaveLength(1);
    });

    it('rejects inconsistent root identities without modifying stored wallets', async () => {
        const { context, state, storage } = await browserHarness();
        await context.generateHdWallet();
        const saved = storage.get('starcoin_wallets');
        const backup = createHdBackup(state.hdRoots[0], mnemonic, 'wrong password', state.wallets);
        await context.importHdBackupFile({ files: [{ size: 1024, text: async () => JSON.stringify(backup) }], value: '' });
        expect(storage.get('starcoin_wallets')).toBe(saved);
        expect(context.showMessage).toHaveBeenCalledWith('txMessage', expect.stringContaining('不匹配'), 'error');
    });

    it('rejects stale writes after another tab changes the persisted allocation', async () => {
        const { context, state, storage } = await browserHarness();
        await context.generateHdWallet();
        const changed = JSON.parse(storage.get('starcoin_wallets'));
        changed.hdRoots[0].nextIndex = 100;
        const serialized = JSON.stringify(changed);
        storage.set('starcoin_wallets', serialized);
        await expect(context.storeHdResult(deriveAddresses(createHdContext(mnemonic), 1))).rejects.toThrow('其他标签页');
        expect(storage.get('starcoin_wallets')).toBe(serialized);
        expect(state.hdRoots[0].nextIndex).toBe(1);
    });
});

describe('HD backup validation', () => {
    it.each([
        { scheme: 'unknown' }, { basePath: 'm/0' }, { nextIndex: -1 }, { nextIndex: 1.5 },
        { addresses: [{ index: 1, label: 'invalid' }] }, { addresses: [{ index: 0, label: 'a' }, { index: 0, label: 'b' }] }
    ])('rejects malformed backup metadata %j', async change => {
        const { context, state } = await browserHarness();
        await context.generateHdWallet();
        const backup = createHdBackup(state.hdRoots[0], mnemonic, '', state.wallets);
        expect(() => parseHdBackup(JSON.stringify({ ...backup, ...change }))).toThrow();
    });
});
