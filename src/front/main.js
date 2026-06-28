/* ============================================================
   渲染：转账表单
   ============================================================ */
function renderTransfer() {
    // 更新发送方下拉
    const fromSel = document.getElementById('fromWallet');
    const currentVal = fromSel.value;
    fromSel.innerHTML = '<option value="">-- 请选择钱包 --</option>' +
        state.wallets.map((w, i) => `<option value="${i}">${w.label} (${shortAddr(w.address, 16)})</option>`).join('');
    // 保持选中
    if (currentVal !== '' && state.wallets[parseInt(currentVal)]) fromSel.value = currentVal;
    else if (state.selectedWallet >= 0) fromSel.value = String(state.selectedWallet);

    // 矿工地址自动填充
    const minerInput = document.getElementById('minerAddress');
    if (state.selectedWallet >= 0 && !minerInput.dataset.manual) {
        minerInput.value = state.wallets[state.selectedWallet].address;
    }

    // 更新签名提示
    const fromIdx = parseInt(document.getElementById('fromWallet').value);
    if (fromIdx >= 0 && state.wallets[fromIdx]) {
        document.getElementById('signInfo').style.display = 'block';
    } else {
        document.getElementById('signInfo').style.display = 'none';
    }

    // 显示发送方余额
    updateFromBalanceHint();
}

document.getElementById('fromWallet').addEventListener('change', renderTransfer);
document.getElementById('minerAddress').addEventListener('input', () => {
    document.getElementById('minerAddress').dataset.manual = '1';
});

async function updateFromBalanceHint() {
    const fromIdx = parseInt(document.getElementById('fromWallet').value);
    if (fromIdx >= 0 && state.wallets[fromIdx]) {
        try {
            const data = await api('/api/balance/' + state.wallets[fromIdx].address);
            let txt;
            if (data.balances && typeof data.balances === 'object') {
                const parts = CURRENCY_SYMBOLS.map(c => {
                    const v = Number(data.balances[c]) || 0;
                    return `${formatBalance(v)} ${c}`;
                });
                txt = '可用余额: ' + parts.join(' / ');
            } else {
                txt = '可用余额: ' + formatBalance(data.balance) + ' STC';
            }
            const locked = Number(data.lockedRewards) || 0;
            if (locked > 0) {
                txt += '（🔒 ' + formatBalance(locked) + ' STC 奖励锁定中）';
            }
            txt += '（未包含交易池中待确认的 ' + (data.pendingTransactions || 0) + ' 笔）';
            document.getElementById('fromBalanceHint').textContent = txt;
        } catch (e) {
            document.getElementById('fromBalanceHint').textContent = '';
        }
    } else {
        document.getElementById('fromBalanceHint').textContent = '';
    }
}

/* ============================================================
   操作：发起交易 + 挖矿
   ============================================================ */
async function submitTransaction() {
    const btn = document.querySelector('button[onclick="submitTransaction()"]');
    const fromIdx = parseInt(document.getElementById('fromWallet').value);
    const to = document.getElementById('toAddress').value.trim();
    const amount = parseFloat(document.getElementById('amount').value);
    const fee = parseFloat(document.getElementById('fee').value) || 0;
    const note = document.getElementById('note').value.trim();
    const currencyEl = document.getElementById('currency');
    const currency = currencyEl ? currencyEl.value : 'STC';  // 多币种

    if (btn && btn.disabled) return;

    if (fromIdx < 0 || !state.wallets[fromIdx]) { showMessage('txMessage', '❌ 请选择发送方钱包', 'error'); return; }
    if (!to) { showMessage('txMessage', '❌ 请填写接收方地址', 'error'); return; }
    if (!amount || amount <= 0) { showMessage('txMessage', '❌ 金额必须大于 0', 'error'); return; }

    const fromWallet = state.wallets[fromIdx];

    if (btn) {
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.dataset.origText = originalText;
        btn.textContent = '⏳ 提交中...';
    }

    clearMessage('txMessage');
    showMessage('txMessage', `🔑 使用 ${fromWallet.label} 的私钥进行 ECDSA 签名（币种: ${currency}）...`, 'info', 0);

    try {
        // 解密私钥（局部变量，不存回 state，函数退出后 GC 回收）
        const masterKey = await getOrCreateMasterKey();
        const privateKeyPem = await decryptPrivateKey(fromWallet.encryptedPrivateKey, masterKey);

        const result = await api('/api/transaction', 'POST', {
            from: fromWallet.address,
            to: to,
            amount: amount,
            fee: fee,
            note: note,
            currency: currency,
            privateKey: privateKeyPem, // 解密后的明文 PEM（仅在此请求中使用）
            publicKey: fromWallet.publicKey
        });

        if (result.success) {
            showMessage('txMessage', '✅ 交易已提交到交易池！（txid: ' + (result.transaction && result.transaction.id ? shortAddr(result.transaction.id, 16) : '') + '）下一步点击"挖矿"来打包这笔交易', 'success', 6000);
            document.getElementById('amount').value = 10;
            document.getElementById('note').value = '';
            // 主动刷新期间，短暂忽略 WebSocket 推送（新交易到达会触发重复刷新）
            if (typeof setIgnoreWs === 'function') setIgnoreWs(2000);
            if (typeof debouncedRefreshAll === 'function') {
                debouncedRefreshAll('high');
            } else {
                await refreshAll();
            }
        } else {
            showMessage('txMessage', '❌ ' + (result.error || '提交失败'), 'error');
        }
    } catch (err) {
        showMessage('txMessage', '❌ 网络错误：' + err.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = btn.dataset.origText || '✍️ 签名并提交交易';
        }
    }
}

// 挖矿相关功能已迁移至 mining.js

/* ============================================================
   渲染：交易池 + 地址榜 + 区块链
   ============================================================ */
async function refreshMempool() {
    try {
        const data = await api('/api/mempool');
        const el = document.getElementById('mempool');
        document.getElementById('statMempool').textContent = data.count || 0;

        if (!data.count || data.count === 0) {
            el.innerHTML = '<div class="mempool-empty">交易池为空，提交一笔转账后会出现在这里</div>';
        } else {
            el.innerHTML = data.transactions.map(tx => {
                const cur = (tx.currency || 'STC').toUpperCase();
                return `
                <div class="mempool-item">
                    <div style="font-weight:bold; color:#60a5fa;">
                        ${shortAddr(tx.from, 10)} → ${shortAddr(tx.to, 10)}: <b>${tx.amount} ${cur}</b>
                        ${tx.fee ? ' <span style="color:#f87171;">🔥 手续费 ' + formatBalance(tx.fee) + ' ' + cur + '（即将燃烧）</span>' : ''}
                    </div>
                    ${tx.note ? '<div style="color:#888; font-size:11px; margin-top:3px;">备注: ' + escapeHtml(tx.note) + '</div>' : ''}
                    <div style="color:#666; font-size:10px; margin-top:3px; font-family:monospace;">txid: ${shortAddr(tx.id, 20)}</div>
                    ${tx.signature ? '<div style="color:#4ade80; font-size:10px; margin-top:2px;">✅ 已 ECDSA 签名' + (tx.nonce !== undefined && tx.nonce !== null ? ' · nonce=' + tx.nonce : '') + '</div>' : ''}
                </div>
            `;}).join('');
        }
    } catch (e) {
        document.getElementById('mempool').textContent = '查询失败';
        document.getElementById('statMempool').textContent = '❌';
    }
}

async function refreshAddressRank() {
    try {
        const data = await api('/api/addresses');
        const el = document.getElementById('addressRank');
        const list = (data.addresses || []).slice(0, 8);
        if (list.length === 0) {
            el.innerHTML = '<div class="mempool-empty">暂无数据</div>';
        } else {
            el.innerHTML = list.map(a => {
                // 多币种余额：按 balances 对象渲染
                let balHtml;
                if (a.balances && typeof a.balances === 'object') {
                    const parts = CURRENCY_SYMBOLS.map(c => {
                        const v = Number(a.balances[c]) || 0;
                        const cls = v > 0 ? 'color:#4ade80;' : (v < 0 ? 'color:#f87171;' : 'color:#6b7280;');
                        return `<span style="${cls}">${formatBalance(v)} ${c}</span>`;
                    });
                    balHtml = parts.join(' | ');
                } else {
                    balHtml = formatBalance(a.balance) + ' STC';
                }
                return `
                <div class="address-row">
                    <span class="addr">${shortAddr(a.address, 18)} <span style="color:#666;">(${a.txCount}笔)</span></span>
                    <span class="bal" style="font-size:11px; white-space:nowrap;">${balHtml}</span>
                </div>
            `;}).join('');
        }
    } catch (e) {
        document.getElementById('addressRank').textContent = '查询失败';
    }
}

async function refreshChain() {
    try {
        const data = await api('/api/blockchain');
        document.getElementById('statBlocks').textContent = data.stats && data.stats.totalBlocks || 0;
        const validStat = document.getElementById('statValid');
        validStat.textContent = data.isValid ? '✓ 有效' : '✗ 无效';
        validStat.className = 'stat-value ' + (data.isValid ? 'valid' : 'invalid');
        document.getElementById('statPort').textContent = data.port || '--';

        // ---- 燃烧手续费统计 ----
        const totalBurned = data.stats ? (data.stats.totalBurnedFees || 0) : 0;
        const statBurnedEl = document.getElementById('statBurnedFees');
        if (statBurnedEl) {
            statBurnedEl.textContent = formatBalance(totalBurned) + ' STC';
            // 数值大时用红色粗体
            if (totalBurned > 0) {
                statBurnedEl.style.color = '#f87171';
            }
        }
        // 难度信息（支持小数难度）
        const difficultyEl = document.getElementById('statDifficulty');
        if (data.stats) {
            const diff = data.stats.difficulty;
            const prefixLen = Math.floor(diff);
            const fraction = diff - prefixLen;
            const zeros = '0'.repeat(prefixLen);
            let targetText;
            if (fraction > 0) {
                const maxNext = Math.max(0, Math.min(255, Math.floor(fraction * 256)));
                targetText = zeros + `[≤0x${maxNext.toString(16).padStart(2,'0')}]…`;
            } else {
                targetText = zeros + '…';
            }
            const targetTime = data.stats.targetBlockTime || 12;
            difficultyEl.innerHTML = `${diff} <span style="font-size:9px;color:#888;">(目标: 0x${targetText} · ${targetTime}s/块)</span>`;
            difficultyEl.title = `当前前缀零目标: ${targetText}\n目标出块时间: ${targetTime}秒\n支持小数难度（如 5.5），每次调整约变化 ${Math.round(16**0.1*100)/100}x 工作量`;
        } else {
            difficultyEl.textContent = '--';
        }

        const el = document.getElementById('chainVisual');
        const chain = data.chain || [];
        if (chain.length === 0) {
            el.innerHTML = '<div class="mempool-empty">暂无区块</div>';
            return;
        }
        el.innerHTML = chain.slice().reverse().map(b => {
            const isGenesis = b.index === 0;
            // 计算本块总燃烧手续费
            let blockBurnedFees = 0;
            let feeTxCount = 0;
            const txList = (b.transactions || []).map(tx => {
                let cls = 'block-tx ';
                let prefix = '';
                if (tx.from === 'SYSTEM' || !tx.from) { cls += 'reward'; prefix = '🎁 '; }
                else if (tx.signature) { cls += 'signed'; prefix = '✍️ '; }
                else { cls += 'unsigned'; prefix = '⚠ '; }

                const fee = Number(tx.fee) || 0;
                if (fee > 0) {
                    blockBurnedFees += fee;
                    feeTxCount++;
                }

                const cur = (tx.currency || 'STC').toUpperCase();
                if (tx.from === 'SYSTEM') {
                    return `<div class="${cls}">${prefix}奖励 → ${shortAddr(tx.to, 10)}: ${tx.amount} ${cur}</div>`;
                }
                if (!tx.from) {
                    return `<div class="${cls}">${prefix}备注: ${escapeHtml(tx.note || tx.to || '')}</div>`;
                }
                // 普通交易：显示币种 + 手续费标签 + nonce
                const feeTag = fee > 0 ? `<span class="fee-tag">🔥${formatBalance(fee)} ${cur}</span>` : '';
                const nonceTag = (tx.nonce !== undefined && tx.nonce !== null) ? `<span style="color:#a78bfa; font-size:10px;"> #n=${tx.nonce}</span>` : '';
                return `<div class="${cls}">${prefix}${shortAddr(tx.from, 8)} → ${shortAddr(tx.to, 8)}: ${tx.amount} ${cur}${tx.fee ? '(费'+formatBalance(tx.fee)+' '+cur+')':''}${feeTag}${nonceTag}</div>`;
            }).join('');

            // 本块燃烧手续费汇总
            const feeSummary = (!isGenesis && blockBurnedFees > 0)
                ? `<div class="block-fee-summary">
                        <span>🔥 本块燃烧: <b>${formatBalance(blockBurnedFees)} STC</b></span>
                        <span style="color:#888;">${feeTxCount} 笔含费交易</span>
                   </div>`
                : '';

            return `
                <div class="block-card ${isGenesis ? 'genesis' : ''}" title="区块 #${b.index}">
                    <div class="block-height">${isGenesis ? '🌱 创世区块' : '📦 区块 #' + b.index}</div>
                    <div class="block-hash">本块: ${shortAddr(b.hash, 24)}</div>
                    <div class="block-hash">前驱: ${shortAddr(b.previousHash, 24)}</div>
                    <div style="color:#888; font-size:10px; margin-top:4px;">Nonce: ${b.nonce} · ${new Date(b.timestamp).toLocaleString()}</div>
                    <div style="margin-top:6px; border-top:1px dashed rgba(255,255,255,0.1); padding-top:6px;">
                        <div style="color:#ffd700; font-size:11px; margin-bottom:4px;">包含交易:</div>
                        ${txList || '<div style="color:#666;font-size:10px;">无交易</div>'}
                    </div>
                    ${feeSummary}
                </div>
            `;
        }).join('');

            // 难度调整历史（放在 try 内部，确保 data 可访问）
            const diffHistoryEl = document.getElementById('chainDiffHistory');
            if (data.stats && data.stats.difficultyHistory && data.stats.difficultyHistory.length > 0) {
                const history = data.stats.difficultyHistory;
                let html = '<div style="margin-top:12px;padding-top:10px;border-top:1px dashed rgba(255,255,255,0.1);">';
                html += '<div style="color:#fbbf24;font-size:11px;font-weight:bold;margin-bottom:6px;">⚙️ 难度调整历史</div>';
                html += history.slice().reverse().map(h => `
                    <div style="font-size:10px;color:#aaa;padding:2px 0;display:flex;justify-content:space-between;">
                        <span>区块 #${h.blockIndex}</span>
                        <span>${h.oldDifficulty} → ${h.newDifficulty}</span>
                        <span style="color:#888;">平均 ${h.avgTime}s</span>
                        <span style="color:${h.reason.includes('↓') ? '#f87171' : '#4ade80'}">${h.reason}</span>
                    </div>
                `).join('');
                html += '</div>';
                diffHistoryEl.innerHTML = html;
            } else {
                diffHistoryEl.innerHTML = '';
            }
    } catch (e) {
        document.getElementById('chainVisual').textContent = '查询失败';
        document.getElementById('statBlocks').textContent = '❌';
        document.getElementById('statDifficulty').textContent = '❌';
        document.getElementById('statValid').textContent = '❌';
        document.getElementById('statPort').textContent = '❌';
        const statBurnedEl = document.getElementById('statBurnedFees');
        if (statBurnedEl) statBurnedEl.textContent = '❌';
    }
}
/* ============================================================
   整体刷新
   ============================================================ */
async function refreshAll() {
    updateFromBalanceHint();
    refreshSelectedWalletDetails();
    renderWallets(); // 重绘以刷新余额
    refreshMempool();
    refreshAddressRank();
    refreshChain();
}

/* ============================================================
   初始化
   ============================================================ */
// WebSocket 活跃时间戳，用于判断是否应跳过备用轮询
let lastWsActivity = Date.now();

(async function init() {
    await loadWallets();
    renderWallets();
    renderTransfer();
    refreshAll();

    // 连接 WebSocket，接收实时推送（新区块/新交易/链更新）
    connectWebSocket();
})();

// 备用轮询：每 60 秒刷新一次（WebSocket 断开时的兜底）
// 如果最近 30 秒内有 WS 活跃推送，跳过本轮轮询，避免与 WS 推送冲突
setInterval(() => {
    if (Date.now() - lastWsActivity < 30000) return;
    refreshMempool();
    refreshChain();
    refreshAddressRank();
}, 60000);