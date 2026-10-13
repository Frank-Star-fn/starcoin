const fs = require('fs'), path = require('path'), vm = require('vm');
const { webcrypto } = require('crypto');
const walletCrypto = require('../../src/front/wallet-crypto');
const { encryptPrivateKey, decryptPrivateKey } = require('../../src/front/keystore');
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const originalMnemonic = require('bip39').entropyToMnemonic('aa'.repeat(16));
const imported = walletCrypto.legacyWallet(mnemonic), original = walletCrypto.legacyWallet(originalMnemonic);

async function harness() {
    const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const storage = new Map(), elements = new Map(), inputs = [];
    function element(id) {
        if (!elements.has(id)) elements.set(id, { value: '', files: [], style: { display: 'block' }, textContent: '', className: '', disabled: false,
            listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; },
            appendChild(child) { this.child = child; }, focus() {}, select() {} });
        return elements.get(id);
    }
    const context = vm.createContext({
        console: { log: vi.fn(), error: vi.fn(), warn: vi.fn() }, setTimeout, clearTimeout,
        walletCrypto: { ...walletCrypto, newMnemonic: () => mnemonic }, confirm: () => true,
        localStorage: { getItem: name => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, value), removeItem: name => storage.delete(name) },
        getOrCreateMasterKey: async () => key,
        encryptPrivateKey: text => encryptPrivateKey(text, key), decryptPrivateKey: value => decryptPrivateKey(value, key),
        renderWallets: vi.fn(), renderTransfer: vi.fn(), refreshSelectedWalletDetails: vi.fn(),
        document: { getElementById: element,
            querySelector: () => ({ querySelector: () => element('walletLabel') }),
            createElement: () => { const input = element('input-' + inputs.length); inputs.push(input); return input; }
        }
    });
    for (const file of ['app.js', 'wallet-manager.js', 'hd-wallet-manager.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/front', file), 'utf8'), context);
    }
    for (const name of ['showMessage', 'showForceBackupDialog', 'showMnemonicDisplay', 'debouncedRefreshAll']) context[name] = vi.fn();
    const encryptedMnemonic = await context.encryptPrivateKey(originalMnemonic);
    context.saveWallets([{ type: 'legacy', label: '原钱包', address: original.address, publicKey: original.publicKey,
        encryptedPrivateKey: await context.encryptPrivateKey(original.privateKey), encryptedMnemonic }], [{ id: 'existing-root', encryptedMnemonic }], 0);
    const state = vm.runInContext('state', context);
    element('walletLabel').textContent = state.wallets[0].label;
    return { context, state, storage, element, inputs };
}

const flows = [
    { name: '创建钱包', run: ctx => ctx.context.generateWallet(), message: 'txMessage' },
    { name: '旧版私钥导入', run: ctx => { ctx.element('importKeyTextarea').value = imported.privateKey; return ctx.context.doImportPrivateKey(); }, message: 'importMessage', input: 'importKeyTextarea' },
    { name: 'PEM 文本导入', run: ctx => { ctx.element('importKeyInput').value = imported.privateKey; return ctx.context.importPrivateKey(); }, message: 'importKeyMessage', input: 'importKeyInput', dialog: 'importKeyDialog', button: 'importKeyBtn' },
    { name: 'PEM 文件导入', run: ctx => { ctx.element('importKeyFile').files = [{ text: async () => imported.privateKey }]; return ctx.context.importPrivateKey(); }, message: 'importKeyMessage', dialog: 'importKeyDialog', button: 'importKeyBtn' },
    { name: '旧版助记词导入', run: ctx => { ctx.element('importMnemonicType').value = 'legacy'; ctx.element('importMnemonicInput').value = mnemonic; return ctx.context.importWalletFromMnemonic(); }, message: 'importMnemonicMessage', input: 'importMnemonicInput', dialog: 'importMnemonicDialog', button: 'importMnemonicBtn' }
];

function failStorage(ctx, name) {
    const error = new DOMException('存储失败：' + name, name);
    ctx.context.localStorage[name === 'SecurityError' ? 'getItem' : 'setItem'] = () => { throw error; };
    return error;
}
function snapshot(ctx) {
    return { wallets: ctx.state.wallets, roots: ctx.state.hdRoots, selected: ctx.state.selectedWallet,
        saved: ctx.storage.get('starcoin_wallets'), cached: vm.runInContext('walletStorageSnapshot', ctx.context) };
}
function expectUnchanged(ctx, before) {
    expect(ctx.state.wallets).toBe(before.wallets);
    expect(ctx.state.hdRoots).toBe(before.roots);
    expect(ctx.state.selectedWallet).toBe(before.selected);
    expect(ctx.storage.get('starcoin_wallets')).toBe(before.saved);
    expect(vm.runInContext('walletStorageSnapshot', ctx.context)).toBe(before.cached);
}

describe('wallet persistence failures', () => {
    it.each(['QuotaExceededError', 'SecurityError'])('reports %s to the storage caller without applying candidate state', async name => {
        const ctx = await harness(), before = snapshot(ctx), error = failStorage(ctx, name);
        expect(() => ctx.context.saveWallets([], [], -1)).toThrow(error);
        expectUnchanged(ctx, before);
        expect(ctx.context.showMessage).not.toHaveBeenCalled();
    });

    it.each(flows.flatMap(flow => ['QuotaExceededError', 'SecurityError'].map(failure => ({ ...flow, failure }))))('$name preserves the old wallet and shows an error on $failure', async flow => {
        const ctx = await harness(), before = snapshot(ctx);
        failStorage(ctx, flow.failure);
        await flow.run(ctx);
        expectUnchanged(ctx, before);
        expect(ctx.context.renderWallets).not.toHaveBeenCalled();
        expect(ctx.context.renderTransfer).not.toHaveBeenCalled();
        expect(ctx.context.debouncedRefreshAll).not.toHaveBeenCalled();
        expect(ctx.context.showForceBackupDialog).not.toHaveBeenCalled();
        expect(ctx.context.showMnemonicDisplay).not.toHaveBeenCalled();
        expect(ctx.context.showMessage.mock.calls.some(call => call[2] === 'success')).toBe(false);
        if (flow.message === 'txMessage') {
            expect(ctx.context.showMessage).toHaveBeenCalledWith('txMessage', expect.stringContaining(flow.failure), 'error');
        } else {
            expect(ctx.element(flow.message).className).toContain('error');
            expect(ctx.element(flow.message).textContent).toContain(flow.failure);
        }
        if (flow.input) expect(ctx.element(flow.input).value).toBe(flow.input === 'importMnemonicInput' ? mnemonic : imported.privateKey);
        if (flow.dialog) expect(ctx.element(flow.dialog).style.display).toBe('block');
        if (flow.button) expect(ctx.element(flow.button).disabled).toBe(false);
    });

    it('rejects a stale create without overwriting another tab or changing local state', async () => {
        const ctx = await harness(), before = snapshot(ctx);
        const remote = JSON.stringify({ ...JSON.parse(before.saved), selectedWallet: -1 });
        ctx.storage.set('starcoin_wallets', remote);
        await ctx.context.generateWallet();
        expectUnchanged(ctx, { ...before, saved: remote });
        expect(ctx.context.showMessage).toHaveBeenCalledWith('txMessage', expect.stringContaining('其他标签页'), 'error');
        expect(ctx.context.showForceBackupDialog).not.toHaveBeenCalled();
    });

    it.each(['选择', '删除', '重命名'])('%s leaves wallet state and storage unchanged when saving fails', async action => {
        const ctx = await harness();
        if (action === '选择') {
            ctx.context.saveWallets(ctx.state.wallets.concat({ type: 'private-key', label: '第二个钱包', address: imported.address,
                encryptedPrivateKey: await ctx.context.encryptPrivateKey(imported.privateKey), publicKey: imported.publicKey }));
        }
        const before = snapshot(ctx);
        failStorage(ctx, 'QuotaExceededError');
        if (action === '选择') ctx.context.selectWallet(1);
        else if (action === '删除') ctx.context.removeWallet(0);
        else {
            ctx.context.renameWallet(0);
            const input = ctx.inputs[0]; input.value = '新名称';
            input.listeners.keydown({ key: 'Enter', stopPropagation() {}, preventDefault() {} });
            expect(ctx.element('walletLabel').textContent).toBe('原钱包');
        }
        expectUnchanged(ctx, before);
        expect(ctx.context.showMessage).toHaveBeenCalledWith('txMessage', expect.stringContaining('QuotaExceededError'), 'error');
        expect(ctx.context.renderWallets).not.toHaveBeenCalled();
    });

    it('keeps the v1 records and backup when encrypted migration cannot be persisted', async () => {
        const ctx = await harness();
        const old = JSON.stringify([{ label: 'v1 钱包', ...imported, mnemonic }]);
        ctx.storage.set('starcoin_wallets', old);
        ctx.storage.set('starcoin_wallets_old', old);
        const before = snapshot(ctx);
        failStorage(ctx, 'QuotaExceededError');
        await ctx.context.loadWallets();
        expectUnchanged(ctx, { ...before, cached: old });
        expect(ctx.storage.get('starcoin_wallets_old')).toBe(old);
        expect(ctx.context.console.log.mock.calls.some(call => call[0].includes('迁移完成'))).toBe(false);
        expect(ctx.context.showMessage).toHaveBeenCalledWith('txMessage', expect.stringContaining('QuotaExceededError'), 'error');
    });
});

describe('wallet persistence success', () => {
    it.each(flows)('$name is encrypted, persisted, and recoverable after reload', async flow => {
        const ctx = await harness();
        await flow.run(ctx);
        const saved = ctx.storage.get('starcoin_wallets'), parsed = JSON.parse(saved);
        expect(parsed.version).toBe(3);
        expect(parsed.selectedWallet).toBe(1);
        expect(parsed.wallets.map(wallet => wallet.address)).toEqual([original.address, imported.address]);
        expect(await ctx.context.decryptPrivateKey(parsed.wallets[1].encryptedPrivateKey)).toBe(imported.privateKey);
        expect(saved).not.toContain(mnemonic);
        expect(saved).not.toContain('BEGIN PRIVATE KEY');
        expect(ctx.context.showMessage.mock.calls.some(call => call[2] === 'success')).toBe(true);
        ctx.state.wallets = []; ctx.state.hdRoots = []; ctx.state.selectedWallet = -1;
        await ctx.context.loadWallets();
        expect(ctx.state.wallets.map(wallet => wallet.address)).toEqual([original.address, imported.address]);
        expect(ctx.state.selectedWallet).toBe(1);
        expect(ctx.state.hdRoots).toEqual(parsed.hdRoots);
    });

    it('persists selection, rename, and removal before applying them to the wallet list', async () => {
        const ctx = await harness();
        await ctx.context.generateWallet();
        ctx.context.selectWallet(0);
        expect(JSON.parse(ctx.storage.get('starcoin_wallets')).selectedWallet).toBe(0);
        ctx.context.renameWallet(0);
        const input = ctx.inputs[0]; input.value = '保存的新名称';
        input.listeners.keydown({ key: 'Enter', stopPropagation() {}, preventDefault() {} });
        ctx.context.removeWallet(1);
        ctx.state.wallets = []; ctx.state.hdRoots = []; ctx.state.selectedWallet = -1;
        await ctx.context.loadWallets();
        expect(ctx.state.wallets).toHaveLength(1);
        expect(ctx.state.wallets[0].address).toBe(original.address);
        expect(ctx.state.wallets[0].label).toBe('保存的新名称');
        expect(ctx.state.selectedWallet).toBe(0);
    });
});
