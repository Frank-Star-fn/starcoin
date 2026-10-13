/* HD roots own the mnemonic; encrypted child PEMs reuse the existing signing flow. */
const hdOperations = new Set();

async function withHdWalletLock(operation) {
    if (typeof navigator !== 'undefined' && navigator.locks) {
        return navigator.locks.request('starcoin-wallets', async () => {
            await loadWallets();
            return operation();
        });
    }
    return operation();
}

async function runHdOperation(key, operation, messageId = 'txMessage') {
    if (hdOperations.has(key)) return;
    hdOperations.add(key);
    try {
        await withHdWalletLock(operation);
    }
    catch (err) { showMessage(messageId, '❌ ' + err.message, 'error'); }
    finally { hdOperations.delete(key); }
}

function findHdRoot(rootId) {
    const root = state.hdRoots.find(r => r.id === rootId);
    if (!root) throw new Error('找不到 HD 钱包');
    return root;
}

async function hdCredentials(root) {
    const key = await getOrCreateMasterKey();
    return { mnemonic: await decryptPrivateKey(root.encryptedMnemonic, key),
        passphrase: root.encryptedPassphrase ? await decryptPrivateKey(root.encryptedPassphrase, key) : '',
        scheme: root.scheme, basePath: root.basePath };
}

function commitHdState(wallets, hdRoots, selectedWallet) {
    // Write before changing memory: quota/storage failures leave the old wallet intact.
    if (walletStorageSnapshot !== undefined && localStorage.getItem('starcoin_wallets') !== walletStorageSnapshot) {
        throw new Error('钱包数据已在其他标签页更新，请刷新后重试');
    }
    const serialized = JSON.stringify({ version: 3, storageType: 'browser-key', wallets, hdRoots, selectedWallet });
    localStorage.setItem('starcoin_wallets', serialized);
    walletStorageSnapshot = serialized;
    state.wallets = wallets;
    state.hdRoots = hdRoots;
    state.selectedWallet = selectedWallet;
}

async function storeHdResult(result, credentials, backup = null) {
    if (backup && backup.rootId !== result.root.id) throw new Error('备份密码或钱包标识不匹配');
    const key = await getOrCreateMasterKey();
    const children = [];
    for (const wallet of result.wallets) {
        const label = backup?.addresses.find(a => a.index === wallet.index)?.label || `地址 #${wallet.index + 1}`;
        children.push({ type: 'hd', rootId: wallet.rootId, index: wallet.index, path: wallet.path,
            label, encryptedPrivateKey: await encryptPrivateKey(wallet.privateKey, key),
            publicKey: wallet.publicKey, address: wallet.address });
    }
    const encrypted = credentials ? {
        encryptedMnemonic: await encryptPrivateKey(credentials.mnemonic.trim().replace(/\s+/g, ' ').toLowerCase(), key),
        encryptedPassphrase: credentials.passphrase ? await encryptPrivateKey(credentials.passphrase, key) : null
    } : {};
    const existing = state.hdRoots.find(r => r.id === result.root.id);
    const root = { ...existing, ...result.root, ...encrypted,
        label: existing?.label || backup?.label || `HD 钱包 #${state.hdRoots.length + 1}`,
        nextIndex: Math.max(existing?.nextIndex || 0, result.nextIndex || 0, backup?.nextIndex || 0),
        scanNextIndex: Math.max(existing?.scanNextIndex || 0, result.scanNextIndex || 0) };
    const roots = existing ? state.hdRoots.map(r => r.id === root.id ? root : r) : state.hdRoots.concat(root);
    const wallets = mergeHdChildren(state.wallets, children);
    let selected = state.selectedWallet;
    if (children.length) selected = wallets.findIndex(w => w.address === children[0].address);
    commitHdState(wallets, roots, selected);
    if (credentials) document.getElementById('keyMismatchOverlay').style.display = 'none';
    renderWallets();
    renderTransfer();
    refreshSelectedWalletDetails();
    return root;
}

async function generateHdWallet() {
    return runHdOperation('create', async () => {
        const result = await api('/api/wallet/hd/new', 'POST', {});
        await storeHdResult(result, { mnemonic: result.mnemonic, passphrase: '' });
        showMnemonicDisplay(result.mnemonic);
        showForceBackupDialog(state.selectedWallet);
        showMessage('txMessage', '✅ HD 钱包已创建，可以继续新增地址。请备份整个 HD 钱包。', 'success', 5000);
    });
}

async function addHdAddress(rootId) {
    return runHdOperation(rootId, async () => {
        const root = findHdRoot(rootId);
        if (root.nextIndex > HD_INDEX_LIMIT) throw new Error('HD 地址索引已耗尽');
        const credentials = await hdCredentials(root);
        const result = await api('/api/wallet/hd/derive', 'POST', { ...credentials, startIndex: root.nextIndex });
        await storeHdResult(result);
        showMessage('txMessage', '✅ 已新增 HD 子地址：' + result.wallets[0].path, 'success', 4000);
    });
}

async function showHdMnemonic(rootId) {
    return runHdOperation(rootId, async () => {
        showMnemonicDisplay((await hdCredentials(findHdRoot(rootId))).mnemonic);
    });
}

function hdRecoveryMessage(result) {
    return `✅ 已恢复 ${result.wallets.length} 个地址，扫描至索引 ${result.scanNextIndex - 1}。`
        + (result.stoppedAtGap ? '连续 20 个地址未使用，已暂停扫描；有更远的地址可点击“继续扫描”。' : '可继续扫描更多地址。');
}

async function importHdMnemonic() {
    const button = document.getElementById('importMnemonicBtn');
    return runHdOperation('import', async () => {
        button.disabled = true;
        button.textContent = '⏳ 恢复中...';
        try {
            const credentials = { mnemonic: document.getElementById('importMnemonicInput').value,
                passphrase: document.getElementById('importMnemonicPassphrase').value };
            const result = await api('/api/wallet/hd/import', 'POST', credentials);
            await storeHdResult(result, credentials);
            hideImportMnemonicDialog();
            showMessage('txMessage', hdRecoveryMessage(result), 'success', 10000);
        } finally {
            button.disabled = false;
            button.textContent = '✅ 导入助记词';
        }
    }, 'importMnemonicMessage');
}

async function continueHdScan(rootId) {
    return runHdOperation(rootId, async () => {
        const root = findHdRoot(rootId);
        if (root.scanNextIndex > HD_INDEX_LIMIT) throw new Error('所有 HD 地址已扫描完毕');
        const result = await api('/api/wallet/hd/import', 'POST', {
            ...await hdCredentials(root), startIndex: root.scanNextIndex });
        await storeHdResult(result);
        showMessage('txMessage', hdRecoveryMessage(result), 'success', 10000);
    });
}

function downloadWalletFile(content, fileName, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

async function exportHdBackup(rootId, askConfirmation = true) {
    const root = findHdRoot(rootId);
    if (askConfirmation && !confirm('导出 ' + root.label + ' 的完整 HD 备份？文件包含助记词和 BIP39 密码，请离线妥善保管。')) return;
    try {
        const backup = await withHdWalletLock(async () => {
            const latest = findHdRoot(rootId);
            const credentials = await hdCredentials(latest);
            return createHdBackup(latest, credentials.mnemonic, credentials.passphrase, state.wallets);
        });
        downloadWalletFile(JSON.stringify(backup, null, 2), `starcoin_hd_${root.id.slice(0, 8)}.json`, 'application/json');
        showMessage('txMessage', '✅ 完整 HD 备份已下载，包含派生方案、地址名称及索引进度。', 'success', 5000);
    } catch (err) {
        if (!askConfirmation) throw err;
        showMessage('txMessage', '❌ HD 备份失败：' + err.message, 'error');
    }
}

async function importHdBackupFile(input) {
    const file = input.files[0];
    if (!file) return;
    return runHdOperation('import', async () => {
        try {
            if (file.size > 2000000) throw new Error('HD 备份文件过大');
            const backup = parseHdBackup(await file.text());
            const credentials = { mnemonic: backup.mnemonic, passphrase: backup.passphrase,
                scheme: backup.scheme, basePath: backup.basePath };
            const discovery = await api('/api/wallet/hd/import', 'POST', credentials);
            if (discovery.root.id !== backup.rootId) throw new Error('备份密码或钱包标识不匹配');
            // Restore saved unused addresses too, including those beyond the discovery gap.
            const recovered = new Map(discovery.wallets.map(w => [w.index, w]));
            const indices = backup.addresses.map(a => a.index).filter(i => !recovered.has(i));
            for (let i = 0; i < indices.length; i += 100) {
                const batch = await api('/api/wallet/hd/derive', 'POST', { ...credentials, indices: indices.slice(i, i + 100) });
                for (const wallet of batch.wallets) recovered.set(wallet.index, wallet);
            }
            await storeHdResult({ ...discovery, wallets: [...recovered.values()].sort((a, b) => a.index - b.index) }, credentials, backup);
            showMessage('txMessage', '✅ HD 备份已恢复，地址名称和索引进度已保留。', 'success', 6000);
        } finally { input.value = ''; }
    });
}

async function renameHdRoot(rootId) {
    const root = findHdRoot(rootId);
    const label = prompt('HD 钱包名称', root.label)?.trim();
    if (!label) return;
    if (label.length > 200) { showMessage('txMessage', '❌ 名称不能超过 200 个字符', 'error'); return; }
    return runHdOperation(rootId, async () => {
        commitHdState(state.wallets, state.hdRoots.map(r => r.id === rootId ? { ...r, label } : r), state.selectedWallet);
        renderWallets();
    });
}

async function removeHdRoot(rootId) {
    const root = findHdRoot(rootId);
    if (!confirm('删除 ' + root.label + ' 及其全部子地址？请确保已导出完整 HD 备份。')) return;
    return runHdOperation(rootId, async () => {
        const selectedAddress = state.wallets[state.selectedWallet]?.address;
        const wallets = state.wallets.filter(w => w.rootId !== rootId);
        commitHdState(wallets, state.hdRoots.filter(r => r.id !== rootId), wallets.findIndex(w => w.address === selectedAddress));
        renderWallets();
        renderTransfer();
        refreshSelectedWalletDetails();
    });
}

if (typeof window !== 'undefined') {
    window.addEventListener('storage', async event => {
        if (event.key !== 'starcoin_wallets' || hdOperations.size) return;
        await loadWallets();
        renderWallets();
        renderTransfer();
        refreshSelectedWalletDetails();
    });
}
