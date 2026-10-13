/* Pure helpers shared by browser storage/backup flows and tests. */
const HD_BACKUP_SCHEME = 'bip44-v1';
const HD_BACKUP_PATH = "m/44'/1'/0'/0";
const HD_INDEX_LIMIT = 0x7fffffff;

function parseHdBackup(text) {
    if (typeof text !== 'string' || text.length > 2000000) throw new Error('HD 备份文件过大或无效');
    let backup;
    try { backup = JSON.parse(text); } catch { throw new Error('无法解析 HD 备份 JSON'); }
    if (!backup || backup.format !== 'starcoin-hd-wallet' || backup.version !== 1
        || backup.scheme !== HD_BACKUP_SCHEME || backup.basePath !== HD_BACKUP_PATH) {
        throw new Error('不支持的 HD 备份格式或派生方案');
    }
    if (typeof backup.mnemonic !== 'string' || backup.mnemonic.length > 1024
        || typeof backup.passphrase !== 'string' || backup.passphrase.length > 1024
        || typeof backup.rootId !== 'string' || !/^[0-9a-f]{64}$/.test(backup.rootId)
        || typeof backup.label !== 'string' || backup.label.length > 200
        || !Number.isSafeInteger(backup.nextIndex) || backup.nextIndex < 1 || backup.nextIndex > HD_INDEX_LIMIT + 1
        || !Array.isArray(backup.addresses) || backup.addresses.length > 10000) {
        throw new Error('HD 备份内容无效');
    }
    const seen = new Set();
    for (const address of backup.addresses) {
        if (!address || !Number.isSafeInteger(address.index) || address.index < 0
            || address.index >= backup.nextIndex || seen.has(address.index)
            || typeof address.label !== 'string' || address.label.length > 200) throw new Error('HD 备份地址索引或名称无效');
        seen.add(address.index);
    }
    return backup;
}

function createHdBackup(root, mnemonic, passphrase, wallets) {
    const backup = { format: 'starcoin-hd-wallet', version: 1, rootId: root.id,
        scheme: root.scheme, basePath: root.basePath, label: root.label,
        mnemonic, passphrase, nextIndex: root.nextIndex,
        addresses: wallets.filter(w => w.rootId === root.id).map(w => ({ index: w.index, label: w.label })) };
    parseHdBackup(JSON.stringify(backup));
    return backup;
}

function mergeHdChildren(existing, incoming) {
    const wallets = existing.slice();
    for (const child of incoming) {
        const index = wallets.findIndex(w => w.address === child.address);
        if (index < 0) wallets.push(child);
        else wallets[index] = { ...child, label: wallets[index].label };
    }
    return wallets;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseHdBackup, createHdBackup, mergeHdChildren };
}
