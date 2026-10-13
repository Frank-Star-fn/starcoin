/* ============================================================
   wallet-ui.js — 钱包 UI 渲染（依赖 app.js + wallet-utils.js）
   ============================================================ */

/* ============================================================
   渲染：钱包列表
   ============================================================ */

const walletHistoryView = { address: null, limit: 10, transactions: [] };
function showMoreWalletHistory() { walletHistoryView.limit += 10; renderWalletHistory(); }
function renderWalletHistory() {
    const address = walletHistoryView.address, transactions = walletHistoryView.transactions, hist = document.getElementById('selectedWalletHistory');
    hist.replaceChildren();
    for (const tx of transactions.slice(0, walletHistoryView.limit)) {
        const display = typeof transactionDisplay === 'function' ? transactionDisplay(tx) : { amount: tx.amount, label: (tx.currency || 'STC').toUpperCase() };
        const row = textElement('div', '', 'history-row');
        row.append(textElement('div', `${tx.from === address ? '→ 转出' : '← 收到'}: ${display.amount} ${display.label}`));
        const links = textElement('div', '区块 ');
        links.append(searchLink('#' + tx.blockIndex, searchBlock, tx.blockIndex), document.createTextNode(' · '),
            searchLink(shortAddr(tx.id, 16), searchTxId, tx.id), document.createTextNode(' · ' + new Date(tx.timestamp).toLocaleString()));
        row.append(links); hist.append(row);
    }
    if (!hist.childNodes.length) hist.textContent = '暂无交易记录';
    const more = document.getElementById('walletHistoryMore');
    if (more) { more.hidden = transactions.length <= walletHistoryView.limit; more.textContent = `加载更多交易（剩余 ${Math.max(0, transactions.length - walletHistoryView.limit)} 条）`; }
}

/**
 * 渲染钱包列表 + 异步查询每个钱包的多币种余额
 */
async function renderWallets() {
    const list = document.getElementById('walletList');

    if (state.wallets.length === 0 && state.hdRoots.length === 0) {
        list.innerHTML = '<div style="color:#888; font-size:13px; padding:20px 0; text-align:center;">还没有钱包<br>点击上方 "＋ 生成新钱包" 开始</div>';
        document.getElementById('selectedWalletInfo').style.display = 'none';
    } else {
        const openMenus = new Set([...list.querySelectorAll?.('details[data-wallet-menu][open]') || []].map(menu => menu.dataset.walletMenu));
        const renderChild = (w, i) => `
            <div data-wallet-index="${i}" class="wallet-item ${i === state.selectedWallet ? 'selected' : ''}" onclick="selectWallet(${i})">
                <button class="wallet-select wallet-label" onclick="event.stopPropagation(); selectWallet(${i})">${escapeHtml(w.label)}</button>
                <div class="wallet-address" title="${escapeHtml(w.address)}">${escapeHtml(shortAddr(w.address, 20))}</div>
                <div class="wallet-balance" id="wallet-balance-${i}">余额: --</div>
                <div class="wallet-actions">
                    <button class="secondary small" onclick="event.stopPropagation(); copyWalletAddress(${i})">复制地址</button>
                    <details class="menu-details" data-wallet-menu="${escapeHtml(w.address)}" onclick="event.stopPropagation()"><summary>更多操作</summary><div class="menu-content">
                    ${w.type === 'hd' ? `<span class="hint">${escapeHtml(w.path)}</span>` : ''}
                    <button class="secondary small" onclick="event.stopPropagation(); exportPrivateKey(${i})">🔑 导出私钥</button>
                    <button class="secondary small" onclick="event.stopPropagation(); setAsReceiver(${i})">设为接收方</button>
                    <button class="secondary small" onclick="event.stopPropagation(); renameWallet(${i})">✏️ 重命名</button>
                    <button class="danger small" onclick="event.stopPropagation(); removeWallet(${i})">删除</button>
                    </div></details>
                </div>
            </div>
        `;
        const hdGroups = state.hdRoots.map(root => `
            <div class="hd-wallet-group" data-hd-root="${escapeHtml(root.id)}" style="margin-bottom:16px;">
                <div style="padding:10px 0; border-bottom:1px solid rgba(96,165,250,0.25);">
                    <strong style="color:#60a5fa;">${escapeHtml(root.label)}</strong>
                    <div class="hint">${state.wallets.filter(w => w.rootId === root.id).length} 个子地址 · 已扫描 ${Number(root.scanNextIndex) || 0} 个地址</div>
                    <div class="wallet-actions">
                        <button class="secondary small" data-hd-action="add">＋ 新增地址</button>
                        <details class="menu-details" data-wallet-menu="${escapeHtml(root.id)}"><summary>备份与管理</summary><div class="menu-content">
                        <button class="secondary small" data-hd-action="export">📁 完整备份</button>
                        <button class="secondary small" data-hd-action="mnemonic">助记词</button>
                        <button class="secondary small" data-hd-action="scan">继续扫描</button>
                        <button class="secondary small" data-hd-action="rename">重命名钱包</button>
                        <button class="danger small" data-hd-action="remove">删除钱包</button>
                        </div></details>
                    </div>
                </div>
                ${state.wallets.map((w, i) => w.rootId === root.id ? renderChild(w, i) : '').join('')}
            </div>
        `).join('');
        const independent = state.wallets.map((w, i) => w.type !== 'hd' ? renderChild(w, i) : '').join('');
        list.innerHTML = hdGroups + (independent ? '<div class="hint">独立地址钱包</div>' + independent : '');
        for (const button of list.querySelectorAll?.('[data-hd-action]') || []) {
            const actions = { add: addHdAddress, export: exportHdBackup, mnemonic: showHdMnemonic,
                scan: continueHdScan, rename: renameHdRoot, remove: removeHdRoot };
            button.addEventListener('click', () => actions[button.dataset.hdAction](button.closest('[data-hd-root]').dataset.hdRoot));
        }
        for (const menu of list.querySelectorAll?.('details[data-wallet-menu]') || []) if (openMenus.has(menu.dataset.walletMenu)) menu.open = true;

        // 异步查询每个钱包余额（多币种）
        for (let i = 0; i < state.wallets.length; i++) {
            try {
                const data = await api('/api/balance/' + state.wallets[i].address);
                const el = document.getElementById('wallet-balance-' + i);
                if (el) {
                    if (data.balances) {
                        el.innerHTML = `${formatBalance(data.balances.STC)} STC${data.lockedRewards > 0 ? ' <span class="hint">· 奖励锁定中</span>' : ''}`;
                    } else {
                        el.innerHTML = '余额: ' + formatBalance(data.balance) + ' STC';
                    }
                }
            } catch (e) {
                // 静默处理单个钱包余额查询失败
            }
        }

        if (state.selectedWallet >= 0) {
            document.getElementById('selectedWalletInfo').style.display = 'block';
        } else document.getElementById('selectedWalletInfo').style.display = 'none';
    }
    renderTransfer();
    if (typeof updateWalletEmpty === 'function') updateWalletEmpty();
}

/**
 * 复制指定索引钱包的地址到剪贴板
 * @param {number} i - 钱包索引
 */
function copyWalletAddress(i) {
    const w = state.wallets[i];
    if (!w) return;
    navigator.clipboard.writeText(w.address).then(() => {
        showMessage('txMessage', '📋 地址已复制', 'success', 1500);
    });
}

/* ============================================================
   渲染：选中钱包详情 + 交易历史
   ============================================================ */

/**
 * 刷新当前选中钱包的详情区域（地址、余额、锁定奖励、成熟度提示、交易历史）
 */
async function refreshSelectedWalletDetails() {
    if (typeof refreshEvmWallet === 'function') refreshEvmWallet();
    if (typeof updateWalletEmpty === 'function') updateWalletEmpty();
    const w = state.wallets[state.selectedWallet];
    if (!w) { document.getElementById('selectedWalletInfo').style.display = 'none'; return; }
    document.getElementById('selectedWalletInfo').style.display = 'block';
    if (walletHistoryView.address !== w.address) { walletHistoryView.address = w.address; walletHistoryView.limit = 10; walletHistoryView.transactions = []; }
    document.getElementById('selectedWalletAddress').textContent = w.address;

    try {
        const data = await api('/api/balance/' + w.address);
        if (w !== state.wallets[state.selectedWallet]) return;
        const balEl = document.getElementById('selectedWalletBalance');
        if (data.balances) {
            balEl.innerHTML = formatMultiCurrencyBalances(data.balances, data.lockedRewards).replace(/^余额: /, '');
        } else {
            let txt = formatBalance(data.balance) + ' STC';
            if (data.lockedRewards > 0) {
                txt += ' <span style="color:#fbbf24;">(🔒 ' + formatBalance(data.lockedRewards) + ' 奖励锁定中)</span>';
            }
            balEl.innerHTML = txt;
        }
        document.getElementById('maturityHint').textContent =
            '⏳ 矿工奖励需 ' + (data.coinbaseMaturity || 5) + ' 个区块确认后才能使用';
    } catch (e) {
        document.getElementById('selectedWalletBalance').textContent = '查询失败';
    }

    // 交易历史（显示币种）
    try {
        const history = await api('/api/transactions/' + w.address);
        if (w !== state.wallets[state.selectedWallet]) return;
        walletHistoryView.transactions = history.transactions || [];
        renderWalletHistory();
    } catch (e) {
        document.getElementById('selectedWalletHistory').textContent = '查询失败';
    }
}

/* ============================================================
   Faucet：领取 cBTC / cETH 测试代币
   ============================================================ */

/**
 * 请求水龙头空投（cBTC / cETH）
 * @param {string} currency - 币种，如 'cBTC' 或 'cETH'
 */
async function requestAirdrop(currency) {
    const w = state.wallets[state.selectedWallet];
    if (!w) {
        showMessage('txMessage', '❌ 请先选择或生成一个钱包', 'error');
        return;
    }
    const msgEl = document.getElementById('airdropMessage');
    if (!msgEl) return;

    const defaultAmounts = { cBTC: 0.01, cETH: 0.5 };
    const amount = defaultAmounts[currency] || 0.01;

    msgEl.textContent = `⏳ 正在领取 ${amount} ${currency} ...`;
    msgEl.style.color = '#fbbf24';

    try {
        const data = await api('/api/token/airdrop', 'POST', {
            address: w.address,
            currency: currency,
            amount: amount
        });
        if (data.success) {
            msgEl.textContent = `✅ 已领取 ${amount} ${currency}，请挖矿打包后到账`;
            msgEl.style.color = '#4ade80';
            // 刷新钱包列表和详情中的余额显示
            refreshSelectedWalletDetails();
            renderWallets();
            // 5 秒后清除消息
            setTimeout(() => {
                msgEl.textContent = '';
                msgEl.style.color = '#888';
            }, 5000);
        } else {
            msgEl.textContent = '❌ ' + (data.error || '领取失败');
            msgEl.style.color = '#f87171';
        }
    } catch (err) {
        msgEl.textContent = '❌ ' + (err.message || '网络错误');
        msgEl.style.color = '#f87171';
    }
}
