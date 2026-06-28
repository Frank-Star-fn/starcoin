/* ============================================================
   wallet-ui.js — 钱包 UI 渲染（依赖 app.js + wallet-utils.js）
   ============================================================ */

/* ============================================================
   渲染：钱包列表
   ============================================================ */

/**
 * 渲染钱包列表 + 异步查询每个钱包的多币种余额
 */
async function renderWallets() {
    const list = document.getElementById('walletList');

    if (state.wallets.length === 0) {
        list.innerHTML = '<div style="color:#888; font-size:13px; padding:20px 0; text-align:center;">还没有钱包<br>点击上方 "＋ 生成新钱包" 开始</div>';
        document.getElementById('selectedWalletInfo').style.display = 'none';
    } else {
        list.innerHTML = state.wallets.map((w, i) => `
            <div class="wallet-item ${i === state.selectedWallet ? 'selected' : ''}" onclick="selectWallet(${i})">
                <div class="wallet-label">${w.label}</div>
                <div class="wallet-address">${escapeHtml(shortAddr(w.address, 40))}</div>
                <div class="wallet-balance" id="wallet-balance-${i}">余额: --</div>
                <div class="wallet-actions">
                    <button class="secondary small" onclick="event.stopPropagation(); exportPrivateKey(${i})">🔑 导出私钥</button>
                    <button class="secondary small" onclick="event.stopPropagation(); copyWalletAddress(${i})">复制地址</button>
                    <button class="secondary small" onclick="event.stopPropagation(); setAsReceiver(${i})">设为接收方</button>
                    <button class="secondary small" onclick="event.stopPropagation(); renameWallet(${i})">✏️ 重命名</button>
                    <button class="danger small" onclick="event.stopPropagation(); removeWallet(${i})">删除</button>
                </div>
            </div>
        `).join('');

        // 异步查询每个钱包余额（多币种）
        for (let i = 0; i < state.wallets.length; i++) {
            try {
                const data = await api('/api/balance/' + state.wallets[i].address);
                const el = document.getElementById('wallet-balance-' + i);
                if (el) {
                    if (data.balances) {
                        el.innerHTML = formatMultiCurrencyBalances(data.balances, data.lockedRewards);
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
        }
    }
    renderTransfer();
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
    const w = state.wallets[state.selectedWallet];
    if (!w) { document.getElementById('selectedWalletInfo').style.display = 'none'; return; }
    document.getElementById('selectedWalletInfo').style.display = 'block';
    document.getElementById('selectedWalletAddress').textContent = w.address;

    try {
        const data = await api('/api/balance/' + w.address);
        const balEl = document.getElementById('selectedWalletBalance');
        if (data.balances) {
            balEl.innerHTML = formatMultiCurrencyBalances(data.balances, data.lockedRewards);
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
        const hist = document.getElementById('selectedWalletHistory');
        if (!history.transactions || history.transactions.length === 0) {
            hist.innerHTML = '<div style="color:#666; font-size:11px; padding:10px; text-align:center;">暂无交易记录</div>';
        } else {
            hist.innerHTML = history.transactions.slice(0, 10).map(tx => {
                const cur = (tx.currency || 'STC').toUpperCase();
                return `
                <div style="background:rgba(255,255,255,0.04); padding:6px 8px; border-radius:4px; margin:4px 0; font-size:11px;">
                    <div style="color:${tx.from === w.address ? '#f87171' : '#4ade80'}; font-weight:bold;">
                        ${tx.from === w.address ? '→ 转出' : '← 收到'}: ${tx.amount} ${cur}
                    </div>
                    <div style="color:#666; font-size:10px; margin-top:2px;">
                        Block <a onclick="searchBlock('${tx.blockIndex}')" style="color:#60a5fa;cursor:pointer;">#${tx.blockIndex}</a>
                        | <span class="tx-id" onclick="searchTxId('${tx.id}')" style="color:#60a5fa;cursor:pointer;font-family:monospace;">${shortAddr(tx.id, 16)}</span>
                        | ${new Date(tx.timestamp).toLocaleString()}
                    </div>
                </div>
            `;}).join('');
        }
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