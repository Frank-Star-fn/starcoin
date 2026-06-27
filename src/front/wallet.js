/* ============================================================
   钱包：生成 + 选择
   ============================================================ */
async function generateWallet() {
    try {
        const data = await api('/api/wallet/new', 'POST');
        if (!data.wallet) throw new Error('生成失败');
        const w = {
            label: '钱包 #' + (state.wallets.length + 1),
            privateKey: data.wallet.privateKey,
            publicKey: data.wallet.publicKey,
            address: data.wallet.address
        };
        state.wallets.push(w);
        state.selectedWallet = state.wallets.length - 1; // 自动选中新钱包
        renderWallets();
        renderTransfer();
        showMessage('txMessage', '✅ 新钱包已生成：' + shortAddr(w.address, 16), 'success');
        saveWallets();
        await refreshAll();
    } catch (err) {
        showMessage('txMessage', '❌ 生成钱包失败：' + err.message, 'error');
    }
}

function selectWallet(index) {
    state.selectedWallet = index;
    renderWallets();
    renderTransfer();
    refreshSelectedWalletDetails();
    saveWallets();
}

function setAsReceiver(index) {
    const w = state.wallets[index];
    if (!w) return;
    document.getElementById('toAddress').value = w.address;
    showMessage('txMessage', '📋 已将 ' + w.label + ' 设为接收方', 'info', 2000);
}

function removeWallet(index) {
    if (!confirm('确定删除 ' + state.wallets[index].label + '？私钥将无法恢复！')) return;
    state.wallets.splice(index, 1);
    if (state.selectedWallet >= state.wallets.length) state.selectedWallet = state.wallets.length - 1;
    renderWallets();
    renderTransfer();
    saveWallets();
}

function copySelectedAddress() {
    const w = state.wallets[state.selectedWallet];
    if (!w) return;
    navigator.clipboard.writeText(w.address).then(() => {
        showMessage('txMessage', '📋 地址已复制到剪贴板', 'success', 2000);
    });
}

/* ============================================================
   渲染：钱包列表
   ============================================================ */
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
                    <button class="secondary small" onclick="event.stopPropagation(); copyWalletAddress(${i})">复制地址</button>
                    <button class="secondary small" onclick="event.stopPropagation(); setAsReceiver(${i})">设为接收方</button>
                    <button class="danger small" onclick="event.stopPropagation(); removeWallet(${i})">删除</button>
                </div>
            </div>
        `).join('');

        // 异步查询每个钱包余额
        for (let i = 0; i < state.wallets.length; i++) {
            try {
                const data = await api('/api/balance/' + state.wallets[i].address);
                const el = document.getElementById('wallet-balance-' + i);
                if (el) {
                    let txt = '余额: ' + (data.balance || 0) + ' STC';
                    if (data.lockedRewards > 0) {
                        txt += ' <span style="color:#fbbf24;font-size:11px;">🔒 +' + data.lockedRewards + ' 锁定</span>';
                    }
                    el.innerHTML = txt;
                }
            } catch (e) {}
        }

        if (state.selectedWallet >= 0) {
            document.getElementById('selectedWalletInfo').style.display = 'block';
        }
    }
    renderTransfer();
}

function copyWalletAddress(i) {
    const w = state.wallets[i];
    if (!w) return;
    navigator.clipboard.writeText(w.address).then(() => {
        showMessage('txMessage', '📋 地址已复制', 'success', 1500);
    });
}

async function refreshSelectedWalletDetails() {
    const w = state.wallets[state.selectedWallet];
    if (!w) { document.getElementById('selectedWalletInfo').style.display = 'none'; return; }
    document.getElementById('selectedWalletInfo').style.display = 'block';
    document.getElementById('selectedWalletAddress').textContent = w.address;

    try {
        const data = await api('/api/balance/' + w.address);
        const balEl = document.getElementById('selectedWalletBalance');
        let txt = (data.balance || 0) + ' STC';
        if (data.lockedRewards > 0) {
            txt += ' <span style="color:#fbbf24;">(🔒 ' + data.lockedRewards + ' 奖励锁定中)</span>';
        }
        balEl.innerHTML = txt;
        // 同时更新锁定期提示
        document.getElementById('maturityHint').textContent =
            '⏳ 矿工奖励需 ' + (data.coinbaseMaturity || 5) + ' 个区块确认后才能使用';
    } catch (e) {
        document.getElementById('selectedWalletBalance').textContent = '查询失败';
    }

    // 交易历史
    try {
        const history = await api('/api/transactions/' + w.address);
        const hist = document.getElementById('selectedWalletHistory');
        if (!history.transactions || history.transactions.length === 0) {
            hist.innerHTML = '<div style="color:#666; font-size:11px; padding:10px; text-align:center;">暂无交易记录</div>';
        } else {
            hist.innerHTML = history.transactions.slice(0, 10).map(tx => `
                <div style="background:rgba(255,255,255,0.04); padding:6px 8px; border-radius:4px; margin:4px 0; font-size:11px;">
                    <div style="color:${tx.from === w.address ? '#f87171' : '#4ade80'}; font-weight:bold;">
                        ${tx.from === w.address ? '→ 转出' : '← 收到'}: ${tx.amount} STC
                    </div>
                    <div style="color:#666; font-size:10px; margin-top:2px;">
                        Block #${tx.blockIndex} | ${new Date(tx.timestamp).toLocaleString()}
                    </div>
                </div>
            `).join('');
        }
    } catch (e) {
        document.getElementById('selectedWalletHistory').textContent = '查询失败';
    }
}