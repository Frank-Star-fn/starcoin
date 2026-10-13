// Isolated browser + HTTP fixtures. This never starts or contacts a blockchain node.
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');
const { Transaction } = require('../src/core');
const { EvmTransaction } = require('../src/evm/transaction');
const requests = [];
const server = http.createServer(async (req, res) => {
    if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html');
        return res.end(fs.readFileSync('public/index.html', 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
    }
    if (!req.url.startsWith('/api/')) return res.end('');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null; requests.push({ url: req.url, method: req.method, body });
    let result = { success: true, addresses: [], transactions: [], count: 0 };
    if (req.url.startsWith('/api/transaction/context/')) result = { success: true, chainId: 'browser-test', nextNonce: 0 };
    if (req.url.includes('/evm/signing-context/')) result = { success: true, chainId: 'browser-test', evmChainId: 155001, nonce: '0', modern: true, gasPriceWei: '10000000000' };
    if (body?.transaction) result = { success: true, transaction: body.transaction };
    if (body?.rawTransaction) result = { success: true, transaction: { id: 'a'.repeat(64), kind: 'evmRaw' } };
    if (req.url.endsWith('/evm/estimate')) result = { success: true, gasLimit: '21000', gasUsed: '21000' };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
});
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });
    try {
        const page = await browser.newPage(); await page.goto('http://127.0.0.1:' + server.address().port); await page.waitForLoadState('networkidle');
        await page.addScriptTag({ path: require.resolve('ethers').replace(/lib.commonjs[\\/]index.js$/, 'dist/ethers.umd.min.js') });
        for (const name of ['wallet-crypto', 'keystore', 'app', 'wallet-utils', 'hd-wallet-state', 'wallet-manager', 'hd-wallet-manager', 'search', 'main', 'evm']) {
            let code = fs.readFileSync('src/front/' + name + '.js', 'utf8');
            if (name === 'main') code = code.split('// WebSocket 活跃时间戳')[0];
            await page.addScriptTag({ content: code });
        }
        const result = await page.evaluate(async () => {
            renderWallets = () => {}; renderTransfer = () => {}; refreshSelectedWalletDetails = () => {};
            debouncedRefreshAll = () => {}; showForceBackupDialog = () => {}; showMnemonicDisplay = () => {};
            window.mmMode = () => false;
            await generateHdWallet(); if (!state.hdRoots.length) throw new Error('HD creation failed');
            await addHdAddress(state.hdRoots[0].id); if (state.wallets.length !== 2) throw new Error('HD derivation failed');
            document.getElementById('importMnemonicInput').value = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
            document.getElementById('importMnemonicPassphrase').value = 'BIP39 browser password';
            await importHdMnemonic(); if (state.hdRoots.length !== 2) throw new Error('HD import failed');
            const selected = state.selectedWallet, wallet = state.wallets[selected];
            const pem = await decryptPrivateKey(wallet.encryptedPrivateKey);
            if (walletCrypto.importPem(pem).address !== wallet.address) throw new Error('PEM import failed');
            const transfer = document.getElementById('fromWallet'); transfer.replaceChildren(new Option('Test', String(selected))); transfer.value = String(selected);
            document.getElementById('toAddress').value = 'b'.repeat(32); document.getElementById('amount').value = '1.00000001';
            document.getElementById('fee').value = '0'; document.getElementById('note').value = 'browser test';
            await submitTransaction();
            evmUi.address = ethers.computeAddress(walletCrypto.rawFromPem(pem)).toLowerCase();
            evmUi.network = { transactionGasLimit: 5000000 };
            document.getElementById('evmDepositTarget').value = evmUi.address; document.getElementById('evmBridgeAmount').value = '1';
            await evmBridge('deposit');
            document.getElementById('evmAbi').value = '["function set(uint256 value)"]';
            document.getElementById('evmMethod').replaceChildren(new Option('set(uint256)', 'set(uint256)'));
            document.getElementById('evmArgs').value = '["1"]'; document.getElementById('evmContract').value = '0x' + '1'.repeat(40);
            document.getElementById('evmValue').value = '0'; await evmEstimate(false);
            await evmSignAndSubmit(evmTxOptions(false));
            let rejected = false;
            try { await api('/api/never', 'POST', { mnemonic: 'secret words' }); } catch { rejected = true; }
            if (!rejected) throw new Error('secret request guard failed');
            return { roots: state.hdRoots.length, wallets: state.wallets.length };
        });
        const native = requests.find(item => item.url === '/api/transaction/signed')?.body.transaction;
        const bridge = requests.find(item => item.url === '/api/evm/signed')?.body.transaction;
        if (!native || !Transaction.fromJSON(native).isValid()) throw new Error('browser native signature invalid');
        if (!bridge || !EvmTransaction.fromJSON(bridge).isValid()) throw new Error('browser bridge signature invalid');
        if (!requests.some(item => item.url === '/api/evm/raw') || !requests.some(item => item.url === '/api/evm/estimate' && item.body.from)) throw new Error('EVM flow incomplete');
        const captured = JSON.stringify(requests);
        if (/"(?:privateKey|privateKeyPem|mnemonic|passphrase)"\s*:/.test(captured) || captured.includes('PRIVATE KEY')
            || captured.includes('abandon abandon') || captured.includes('BIP39 browser password') || requests.some(item => item.url.includes('/wallet'))) throw new Error('wallet secret sent');
        console.log(JSON.stringify({ ...result, requests: requests.length, secretRequests: 0, nativeSignatureValid: true, bridgeSignatureValid: true }));
    } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { server.closeAllConnections(); server.close(); console.error(error); process.exitCode = 1; });
