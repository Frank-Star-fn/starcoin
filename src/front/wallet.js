/* ============================================================
   钱包：生成 + 选择（支持多币种）
   ============================================================ */
const CURRENCY_SYMBOLS = ['STC', 'cBTC', 'cETH'];

function formatBalance(num) {
    if (num === undefined || num === null || isNaN(Number(num))) return '0';
    return Number(num).toFixed(6).replace(/\.?0+$/, '');
}

/**
 * 渲染一个多币种余额 HTML（按币种格式化，为 0 的币种显示为灰色小字，不为 0 的突出显示
 */
function formatMultiCurrencyBalances(balances, lockedRewardsObj) {
    if (!balances) return '余额: --';
    const parts = [];
    for (const cur of CURRENCY_SYMBOLS) {
        const bal = Number(balances[cur]) || 0;
        const balStr = formatBalance(bal);
        if (bal > 0) {
            parts.push(`<span style="color:#4ade80;">${balStr} ${cur}</span>`);
        } else if (bal < 0) {
            parts.push(`<span style="color:#f87171;">${balStr} ${cur}</span>`);
        } else {
            parts.push(`<span style="color:#6b7280;">${balStr} ${cur}</span>`);
        }
    }
    let html = '余额: ' + parts.join(' &nbsp;|&nbsp; ');

    // 锁定奖励（目前只有 STC 有锁定（矿工奖励）
    if (lockedRewardsObj && typeof lockedRewardsObj === 'object') {
        const totalLocked = Object.values(lockedRewardsObj).reduce((s, v) => s + (Number(v) || 0), 0);
        if (totalLocked > 0) {
            html += ` <span style="color:#fbbf24;font-size:11px;">🔒 锁定中</span>`;
        }
    } else if (typeof lockedRewardsObj === 'number' && lockedRewardsObj > 0) {
        html += ` <span style="color:#fbbf24;font-size:11px;">🔒 +${formatBalance(lockedRewardsObj)} 锁定</span>`;
    }
    return html;
}

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
   私钥导出 / 导入
   ============================================================ */

/**
 * 导出指定钱包的私钥（下载为 .pem 文件）
 */
function exportPrivateKey(index) {
    const w = state.wallets[index];
    if (!w) return;
    if (!confirm(`⚠️ 即将导出「${w.label}」的私钥。\n私钥可完全控制该钱包资产，请妥善保管，切勿泄露！\n\n确定导出吗？`)) return;

    // 构造 .pem 文件内容并下载
    const blob = new Blob([w.privateKey], { type: 'application/x-pem-file' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `starcoin_${w.label.replace(/[^a-zA-Z0-9_#]/g, '_')}_${w.address.substring(0, 8)}.pem`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showMessage('txMessage', `✅ 私钥已导出为文件：${a.download}`, 'success', 5000);
}

/**
 * 切换私钥导入区域的显示/隐藏
 */
function toggleImportArea() {
    const area = document.getElementById('importArea');
    const btn = document.getElementById('importBtn');
    if (area.style.display === 'none') {
        area.style.display = 'block';
        btn.textContent = '✕ 关闭导入';
        // 清空上次输入和消息
        document.getElementById('importKeyTextarea').value = '';
        document.getElementById('importMessage').textContent = '';
        document.getElementById('importMessage').className = 'message';
    } else {
        area.style.display = 'none';
        btn.textContent = '📥 导入私钥';
    }
}

/**
 * 执行私钥导入
 */
async function doImportPrivateKey() {
    const textarea = document.getElementById('importKeyTextarea');
    const msgEl = document.getElementById('importMessage');
    const privateKey = textarea.value.trim();

    if (!privateKey) {
        msgEl.textContent = '❌ 请粘贴私钥内容';
        msgEl.className = 'message error';
        return;
    }

    msgEl.textContent = '⏳ 正在导入...';
    msgEl.className = 'message info';

    try {
        const data = await api('/api/wallet/import', 'POST', { privateKey });
        if (!data.success || !data.wallet) {
            throw new Error(data.error || '导入失败');
        }
        const w = data.wallet;

        // 检查是否已存在相同的钱包
        const exists = state.wallets.some(ew => ew.address === w.address);
        if (exists) {
            msgEl.className = 'message warning';
            msgEl.textContent = '⚠️ 该私钥对应的钱包已存在，无需重复导入';
            return;
        }

        state.wallets.push({
            label: '钱包 #' + (state.wallets.length + 1) + ' (导入)',
            privateKey: w.privateKey,
            publicKey: w.publicKey,
            address: w.address
        });
        state.selectedWallet = state.wallets.length - 1;
        saveWallets();
        renderWallets();
        renderTransfer();

        // 关闭导入区域
        toggleImportArea();

        showMessage('txMessage', '✅ 私钥导入成功！地址：' + shortAddr(w.address, 16), 'success', 5000);
        await refreshAll();
    } catch (err) {
        msgEl.textContent = '❌ ' + err.message;
        msgEl.className = 'message error';
    }
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
                    <button class="secondary small" onclick="event.stopPropagation(); exportPrivateKey(${i})">🔑 导出私钥</button>
                    <button class="secondary small" onclick="event.stopPropagation(); copyWalletAddress(${i})">复制地址</button>
                    <button class="secondary small" onclick="event.stopPropagation(); setAsReceiver(${i})">设为接收方</button>
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
   私钥导出：下载 PEM 文件（不经过网络）
   ============================================================ */
function exportPrivateKey(index) {
    const w = state.wallets[index];
    if (!w) return;

    // 安全确认
    if (!confirm(`⚠️  即将导出私钥！\n\n钱包: ${w.label}\n地址: ${shortAddr(w.address, 20)}\n\n持有私钥即可完全控制该钱包中的资产。\n请确保在安全的环境下操作。\n\n确认导出吗？`)) return;

    // 构建 .pem 文件内容
    const pemContent = w.privateKey;
    const shortAddrPart = w.address.substring(0, 8);
    const fileName = `starcoin_wallet_${shortAddrPart}.pem`;

    // 下载文件
    const blob = new Blob([pemContent], { type: 'application/x-pem-file' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showMessage('txMessage', `✅ 私钥已导出: ${fileName}\n📁 请妥善保管！`, 'success', 5000);
}

/* ============================================================
   私钥导入：显示对话框
   ============================================================ */
function showImportKeyDialog() {
    const dialog = document.getElementById('importKeyDialog');
    dialog.style.display = 'block';
    document.getElementById('importKeyInput').value = '';
    document.getElementById('importKeyMessage').className = 'message';
    document.getElementById('importKeyMessage').textContent = '';
    document.getElementById('importKeyBtn').disabled = false;
    document.getElementById('importKeyBtn').textContent = '✅ 导入';
    document.getElementById('importKeyFile').value = '';
}

function hideImportKeyDialog() {
    document.getElementById('importKeyDialog').style.display = 'none';
}

/* ============================================================
   私钥导入：提交到后端验证并恢复钱包
   ============================================================ */
async function importPrivateKey() {
    const btn = document.getElementById('importKeyBtn');
    const input = document.getElementById('importKeyInput');
    const msgEl = document.getElementById('importKeyMessage');
    const fileInput = document.getElementById('importKeyFile');

    let pemText = input.value.trim();

    // 优先检查是否有文件被选中
    if (fileInput.files && fileInput.files.length > 0) {
        try {
            pemText = await fileInput.files[0].text();
            pemText = pemText.trim();
        } catch (e) {
            msgEl.className = 'message error';
            msgEl.textContent = '❌ 文件读取失败: ' + e.message;
            return;
        }
    }

    if (!pemText) {
        msgEl.className = 'message error';
        msgEl.textContent = '❌ 请粘贴私钥 PEM 内容或选择 .pem 文件';
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ 验证中...';
    }
    msgEl.className = 'message info';
    msgEl.textContent = '🔑 正在验证 PEM 私钥...';

    try {
        const result = await api('/api/wallet/import', 'POST', { privateKeyPem: pemText });

        if (result.success) {
            const w = result.wallet;
            // 检查是否已存在相同地址的钱包
            const exists = state.wallets.some(ex => ex.address === w.address);
            if (exists) {
                msgEl.className = 'message error';
                msgEl.textContent = '⚠️  该私钥对应的钱包已存在，无需重复导入';
                if (btn) { btn.disabled = false; btn.textContent = '✅ 导入'; }
                return;
            }

            // 添加到钱包列表
            const walletEntry = {
                label: '钱包 #' + (state.wallets.length + 1) + '（导入）',
                privateKey: w.privateKey,
                publicKey: w.publicKey,
                address: w.address
            };
            state.wallets.push(walletEntry);
            state.selectedWallet = state.wallets.length - 1; // 自动选中
            renderWallets();
            renderTransfer();
            saveWallets();
            hideImportKeyDialog();
            showMessage('txMessage', `✅ 私钥导入成功！地址: ${shortAddr(w.address, 20)}`, 'success', 5000);
            await refreshAll();
        } else {
            msgEl.className = 'message error';
            msgEl.textContent = '❌ ' + (result.error || '导入失败');
            if (btn) { btn.disabled = false; btn.textContent = '✅ 导入'; }
        }
    } catch (err) {
        msgEl.className = 'message error';
        msgEl.textContent = '❌ 导入失败: ' + err.message;
        if (btn) { btn.disabled = false; btn.textContent = '✅ 导入'; }
    }
}

/* ============================================================
   私钥导入：文件选择自动加载
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('importKeyFile');
    if (fileInput) {
        fileInput.addEventListener('change', async (e) => {
            if (e.target.files && e.target.files.length > 0) {
                try {
                    const text = await e.target.files[0].text();
                    document.getElementById('importKeyInput').value = text;
                    showMessage('importKeyMessage', '📄 已加载文件，点击 "导入" 完成导入', 'info', 0);
                } catch (err) {
                    showMessage('importKeyMessage', '❌ 文件读取失败: ' + err.message, 'error', 0);
                }
            }
        });
    }
});