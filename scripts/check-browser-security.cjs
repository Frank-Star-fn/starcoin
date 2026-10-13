// Run with the bundled Playwright available via NODE_PATH. No live node is used.
const fs = require('fs');
const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });
    try {
        const page = await browser.newPage();
        const html = fs.readFileSync('public/index.html', 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
        await page.setContent(html); await page.waitForLoadState('networkidle');
        await page.addStyleTag({ path: 'public/style.css' });
        await page.addStyleTag({ path: 'public/workspace.css' });
        for (const name of ['app', 'wallet-utils', 'search', 'wallet-ui', 'workspace', 'main']) {
            let code = fs.readFileSync('src/front/' + name + '.js', 'utf8');
            if (name === 'workspace') code = code.split('// Shared gas controls')[0];
            if (name === 'main') code = code.split('// WebSocket 活跃时间戳')[0];
            await page.addScriptTag({ content: code });
        }
        const result = await page.evaluate(async () => {
            globalThis.pwned = 0;
            const evil = `<img src=x onerror="globalThis.pwned++">');globalThis.pwned++;//`;
            const tx = { id: evil, from: evil, to: evil, amount: evil, currency: evil, note: evil,
                signature: evil, fee: 0, blockIndex: evil };
            const result = { block: { index: evil, hash: evil, previousHash: evil, nonce: evil, transactions: [tx] },
                transaction: tx, blockIndex: evil, confirmations: evil, address: evil,
                addresses: [{ address: evil, balance: 1, txCount: evil }], transactions: [tx], message: evil };
            let checked = 0;
            for (const type of ['block', 'transaction', 'address', 'address_list', 'note', 'mempool']) {
                renderSearchResults({ success: true, type, result });
                const content = document.getElementById('searchResultsContent');
                if (content.querySelector('img,[onerror],[onclick]')) throw new Error(type + ': unsafe DOM');
                if (!content.textContent.includes(evil)) throw new Error(type + ': missing text'); checked++;
            }
            walletHistoryView.transactions = [tx]; renderWalletHistory();
            renderBlockList([result.block]);
            api = async url => url.endsWith('/mempool') ? { count: 1, transactions: [tx] } : { addresses: result.addresses };
            await refreshMempool(); await refreshAddressRank();
            for (const id of ['selectedWalletHistory', 'chainVisual', 'mempool', 'addressRank']) {
                if (document.getElementById(id).querySelector('img,[onerror]')) throw new Error(id + ': unsafe DOM'); checked++;
            }
            const received = []; const link = searchLink(evil, value => received.push(value), evil);
            document.body.append(link); link.click();
            if (received[0] !== evil || globalThis.pwned) throw new Error('code execution');
            return { checked, payloadExecuted: globalThis.pwned };
        });
        console.log(JSON.stringify(result));
        await page.setViewportSize({ width: 375, height: 900 });
        await page.evaluate(() => {
            document.querySelectorAll('.workspace-page').forEach(page => { page.hidden = page.id !== 'page-explorer'; });
            document.getElementById('searchResults').style.display = 'block';
        });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        if (overflow > 1) {
            console.log(await page.evaluate(() => [...document.querySelectorAll('body *')]
                .filter(el => el.getBoundingClientRect().width && (el.getBoundingClientRect().right > innerWidth + 1 || el.scrollWidth > el.clientWidth + 1))
                .map(el => ({ tag: el.tagName, id: el.id, className: el.className, right: el.getBoundingClientRect().right, width: el.clientWidth, scrollWidth: el.scrollWidth })).slice(0, 15)));
            throw new Error('mobile horizontal overflow: ' + overflow);
        }
        console.log('Mobile search layout: no horizontal overflow');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
