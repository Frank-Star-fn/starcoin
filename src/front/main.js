/* ============================================================
   工具：格式化余额（最多保留 6 位小数）
   ============================================================ */
function formatBalance(num) {
    if (num === undefined || num === null || isNaN(Number(num))) return '0';
    return Number(num).toFixed(6).replace(/\.?0+$/, '');
}

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
            let txt = '可用余额: ' + formatBalance(data.balance) + ' STC';
            if (data.lockedRewards > 0) {
                txt += '（🔒 ' + formatBalance(data.lockedRewards) + ' 奖励锁定中，共 ' + formatBalance(data.totalBalance) + ' STC）';
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
    showMessage('txMessage', '🔑 使用 ' + fromWallet.label + ' 的私钥进行 ECDSA 签名...', 'info', 0);

    try {
        const result = await api('/api/transaction', 'POST', {
            from: fromWallet.address,
            to: to,
            amount: amount,
            fee: fee,
            note: note,
            privateKey: fromWallet.privateKey,
            publicKey: fromWallet.publicKey
        });

        if (result.success) {
            showMessage('txMessage', '✅ 交易已提交到交易池！（txid: ' + (result.transaction && result.transaction.id ? shortAddr(result.transaction.id, 16) : '') + '）下一步点击"挖矿"来打包这笔交易', 'success', 6000);
            document.getElementById('amount').value = 10;
            document.getElementById('note').value = '';
            await refreshAll();
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
            el.innerHTML = data.transactions.map(tx => `
                <div class="mempool-item">
                    <div style="font-weight:bold; color:#60a5fa;">
                        ${shortAddr(tx.from, 10)} → ${shortAddr(tx.to, 10)}: <b>${tx.amount} STC</b>
                        ${tx.fee ? ' <span style="color:#f87171;">🔥 手续费 ' + tx.fee + ' STC（即将燃烧）</span>' : ''}
                    </div>
                    ${tx.note ? '<div style="color:#888; font-size:11px; margin-top:3px;">备注: ' + escapeHtml(tx.note) + '</div>' : ''}
                    <div style="color:#666; font-size:10px; margin-top:3px; font-family:monospace;">txid: ${shortAddr(tx.id, 20)}</div>
                    ${tx.signature ? '<div style="color:#4ade80; font-size:10px; margin-top:2px;">✅ 已 ECDSA 签名</div>' : ''}
                </div>
            `).join('');
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
            el.innerHTML = list.map(a => `
                <div class="address-row">
                    <span class="addr">${shortAddr(a.address, 18)} <span style="color:#666;">(${a.txCount}笔)</span></span>
                    <span class="bal">${formatBalance(a.balance)} STC</span>
                </div>
            `).join('');
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
            statBurnedEl.textContent = totalBurned + ' STC';
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

                if (tx.from === 'SYSTEM') {
                    return `<div class="${cls}">${prefix}奖励 → ${shortAddr(tx.to, 10)}: ${tx.amount} STC</div>`;
                }
                if (!tx.from) {
                    return `<div class="${cls}">${prefix}备注: ${escapeHtml(tx.note || tx.to || '')}</div>`;
                }
                // 普通交易：显示手续费标签
                const feeTag = fee > 0 ? `<span class="fee-tag">🔥${fee}</span>` : '';
                return `<div class="${cls}">${prefix}${shortAddr(tx.from, 8)} → ${shortAddr(tx.to, 8)}: ${tx.amount} STC${tx.fee ? '(费'+tx.fee+')':''}${feeTag}</div>`;
            }).join('');

            // 本块燃烧手续费汇总
            const feeSummary = (!isGenesis && blockBurnedFees > 0)
                ? `<div class="block-fee-summary">
                        <span>🔥 本块燃烧: <b>${blockBurnedFees} STC</b></span>
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
   搜索功能
   ============================================================ */

// 按 Enter 触发搜索
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('searchInput');
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                performSearch();
            }
        });
    }
});

/**
 * 执行搜索（全局函数，由 HTML onclick 调用）
 */
async function performSearch() {
    const input = document.getElementById('searchInput');
    const query = (input.value || '').trim();
    if (!query) {
        closeSearchResults();
        return;
    }

    const panel = document.getElementById('searchResults');
    const content = document.getElementById('searchResultsContent');
    panel.style.display = 'block';
    content.innerHTML = '<div class="search-loading">搜索中...</div>';

    // 滚动到搜索结果区域
    setTimeout(() => {
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);

    try {
        const data = await api('/api/search?q=' + encodeURIComponent(query));
        renderSearchResults(data);
    } catch (err) {
        content.innerHTML = `<div class="search-result-card">
            <span class="search-result-type error-type">❌ 错误</span>
            <div class="search-not-found">搜索请求失败: ${escapeHtml(err.message)}</div>
        </div>`;
    }
}

/**
 * 关闭搜索结果面板
 */
function closeSearchResults() {
    const panel = document.getElementById('searchResults');
    panel.style.display = 'none';
}

/**
 * 根据搜索类型渲染结果
 */
function renderSearchResults(data) {
    const content = document.getElementById('searchResultsContent');

    if (!data || !data.success) {
        content.innerHTML = `<div class="search-result-card">
            <span class="search-result-type error-type">❌ 错误</span>
            <div class="search-not-found">搜索失败: ${escapeHtml(data ? data.error : '未知错误')}</div>
        </div>`;
        return;
    }

    switch (data.type) {
        case 'block':
            renderBlockResult(content, data.result, data.query);
            break;
        case 'transaction':
            renderTxResult(content, data.result, data.query);
            break;
        case 'address':
            renderAddressResult(content, data.result, data.query);
            break;
        case 'address_list':
            renderAddressListResult(content, data.result, data.query);
            break;
        case 'note':
            renderNoteResult(content, data.result, data.query);
            break;
        case 'mempool':
            renderMempoolResult(content, data.result, data.query);
            break;
        case 'not_found':
            content.innerHTML = `<div class="search-result-card">
                <span class="search-result-type error-type">🔍 未找到</span>
                <div class="search-not-found">${escapeHtml(data.result ? data.result.message : '未找到结果')}</div>
                ${data.result && data.result.hint ? '<div class="search-hint">💡 ' + escapeHtml(data.result.hint) + '</div>' : ''}
            </div>`;
            break;
        case 'empty':
            content.innerHTML = `<div class="search-result-card">
                <div class="search-not-found">请输入搜索关键词</div>
                <div class="search-hint">💡 支持搜索：区块号、交易ID、地址、备注文字</div>
            </div>`;
            break;
        default:
            content.innerHTML = `<div class="search-result-card">
                <span class="search-result-type error-type">未知结果类型</span>
                <div class="search-not-found">请重新搜索</div>
            </div>`;
    }
}

/** 渲染区块结果 */
function renderBlockResult(content, result, query) {
    const block = result.block;
    const isGenesis = block.index === 0;
    let txListHtml = '';
    if (block.transactions && block.transactions.length > 0) {
        txListHtml = '<div class="search-tx-list">' +
            block.transactions.map(tx => {
                let cls = 'search-tx-item ';
                let prefix = '';
                if (tx.from === 'SYSTEM' || !tx.from) {
                    cls += 'tx-reward';
                    prefix = '🎁 奖励';
                } else if (tx.signature) {
                    cls += 'tx-signed';
                    prefix = '✍️ 转账';
                }
                return `<div class="${cls}">
                    <div>${prefix}: ${tx.from !== 'SYSTEM' ? shortAddr(tx.from, 10) + ' → ' : ''}${shortAddr(tx.to, 10)}: <b>${tx.amount} STC</b>${tx.fee ? ' <span style="color:#f87171;">🔥手续费 ' + tx.fee + '</span>' : ''}</div>
                    <div class="tx-id" onclick="searchTxId('${tx.id}')">${shortAddr(tx.id, 24)}</div>
                    ${tx.note ? '<div style="color:#888;">备注: ' + escapeHtml(tx.note) + '</div>' : ''}
                </div>`;
            }).join('') +
            '</div>';
    } else {
        txListHtml = '<div style="color:#666; font-size:12px; padding:8px;">此区块无交易</div>';
    }

    content.innerHTML = `<div class="search-result-card">
        <span class="search-result-type block-type">📦 区块</span>
        <button class="search-close-btn" onclick="closeSearchResults()">✕</button>
        <div class="search-result-row">
            <span class="search-result-label">区块高度</span>
            <span class="search-result-value highlight">#${block.index} ${isGenesis ? '🌱 创世区块' : ''}</span>
        </div>
        <div class="search-result-row">
            <span class="search-result-label">区块哈希</span>
            <span class="search-result-value">${block.hash}</span>
        </div>
        <div class="search-result-row">
            <span class="search-result-label">前驱哈希</span>
            <span class="search-result-value">${block.previousHash}</span>
        </div>
        <div class="search-result-row">
            <span class="search-result-label">时间戳</span>
            <span class="search-result-value">${new Date(block.timestamp).toLocaleString()}</span>
        </div>
        <div class="search-result-row">
            <span class="search-result-label">Nonce</span>
            <span class="search-result-value">${block.nonce}</span>
        </div>
        <div class="search-result-row">
            <span class="search-result-label">包含交易数</span>
            <span class="search-result-value">${result.transactionCount} 笔</span>
        </div>
        ${result.totalBurnedFees > 0 ? `<div class="search-result-row">
            <span class="search-result-label">🔥 本块燃烧手续费</span>
            <span class="search-result-value" style="color:#f87171;">${result.totalBurnedFees} STC</span>
        </div>` : ''}
        <div style="margin-top:10px; padding-top:10px; border-top:1px dashed rgba(255,255,255,0.1);">
            <div style="font-size:12px; color:#ffd700; margin-bottom:6px;">交易列表:</div>
            ${txListHtml}
        </div>
    </div>`;
}

/** 渲染交易结果 */
function renderTxResult(content, result, query) {
    const tx = result.transaction;
    const isReward = tx.from === 'SYSTEM' || !tx.from;
    const status = result.confirmations >= 6 ? '✅ 已确认' : `⏳ ${result.confirmations} 个确认`;

    content.innerHTML = `<div class="search-result-card">
        <span class="search-result-type tx-type">✍️ 交易</span>
        <button class="search-close-btn" onclick="closeSearchResults()">✕</button>
        <div class="search-result-row">
            <span class="search-result-label">交易 ID</span>
            <span class="search-result-value">${tx.id}</span>
        </div>
        <div class="search-result-row">
            <span class="search-result-label">所在区块</span>
            <span class="search-result-value highlight">
                <a onclick="searchBlock('${result.blockIndex}')">#${result.blockIndex}</a>
                (${shortAddr(result.blockHash, 16)})
            </span>
        </div>
        <div class="search-result-row">
            <span class="search-result-label">确认数</span>
            <span class="search-result-value" style="color:${result.confirmations >= 6 ? '#4ade80' : '#fbbf24'}">${status}</span>
        </div>
        ${isReward ? `<div class="search-result-row">
            <span class="search-result-label">类型</span>
            <span class="search-result-value" style="color:#4ade80;">🎁 挖矿奖励</span>
        </div>` : `
        <div class="search-result-row">
            <span class="search-result-label">发送方</span>
            <span class="search-result-value"><a onclick="searchAddress('${tx.from}')">${tx.from}</a></span>
        </div>
        <div class="search-result-row">
            <span class="search-result-label">接收方</span>
            <span class="search-result-value"><a onclick="searchAddress('${tx.to}')">${tx.to}</a></span>
        </div>
        `}
        <div class="search-result-row">
            <span class="search-result-label">金额</span>
            <span class="search-result-value highlight">${tx.amount} STC</span>
        </div>
        ${tx.fee ? `<div class="search-result-row">
            <span class="search-result-label">🔥 手续费</span>
            <span class="search-result-value" style="color:#f87171;">${tx.fee} STC（已燃烧）</span>
        </div>` : ''}
        ${tx.note ? `<div class="search-result-row">
            <span class="search-result-label">备注</span>
            <span class="search-result-value">${escapeHtml(tx.note)}</span>
        </div>` : ''}
        ${tx.signature ? `<div class="search-result-row">
            <span class="search-result-label">签名</span>
            <span class="search-result-value" style="color:#4ade80; font-size:10px;">${shortAddr(tx.signature, 32)}...</span>
        </div>` : ''}
    </div>`;
}

/** 渲染地址结果 */
function renderAddressResult(content, result, query) {
    const txHtml = result.transactions && result.transactions.length > 0
        ? '<div class="search-tx-list">' + result.transactions.map(tx => {
            const isReward = tx.from === 'SYSTEM' || !tx.from;
            const cls = isReward ? 'tx-reward' : 'tx-signed';
            return `<div class="search-tx-item ${cls}">
                <div>${isReward ? '🎁 奖励' : '✍️ 转账'}: ${!isReward ? shortAddr(tx.from, 10) + ' → ' : ''}${shortAddr(tx.to, 10)}: <b>${tx.amount} STC</b>${tx.fee ? ' 🔥费' + tx.fee : ''}</div>
                <div class="tx-id" onclick="searchTxId('${tx.id}')">${shortAddr(tx.id, 24)}</div>
                ${tx.note ? '<div style="color:#888;">' + escapeHtml(tx.note) + '</div>' : ''}
            </div>`;
        }).join('') + '</div>'
        : '<div style="color:#666; font-size:12px; padding:8px;">此地址暂无交易记录</div>';

    content.innerHTML = `<div class="search-result-card">
        <span class="search-result-type address-type">💼 地址</span>
        <button class="search-close-btn" onclick="closeSearchResults()">✕</button>
        <div class="search-result-row">
            <span class="search-result-label">地址</span>
            <span class="search-result-value" style="font-size:13px;">${result.address}</span>
        </div>
        <div class="search-result-row">
            <span class="search-result-label">余额（可用）</span>
            <span class="search-result-value highlight">${formatBalance(result.balance)} STC</span>
        </div>
        ${result.lockedRewards > 0 ? `<div class="search-result-row">
            <span class="search-result-label">🔒 锁定奖励</span>
            <span class="search-result-value" style="color:#fbbf24;">${formatBalance(result.lockedRewards)} STC</span>
        </div>` : ''}
        ${result.totalBalance !== result.balance ? `<div class="search-result-row">
            <span class="search-result-label">总余额（含锁定）</span>
            <span class="search-result-value" style="color:#888;">${formatBalance(result.totalBalance)} STC</span>
        </div>` : ''}
        <div class="search-result-row">
            <span class="search-result-label">交易总数</span>
            <span class="search-result-value">${result.transactionCount} 笔</span>
        </div>
        ${result.pendingTransactions > 0 ? `<div class="search-result-row">
            <span class="search-result-label">待确认交易</span>
            <span class="search-result-value" style="color:#f87171;">${result.pendingTransactions} 笔（在交易池中）</span>
        </div>` : ''}
        <div style="margin-top:10px; padding-top:10px; border-top:1px dashed rgba(255,255,255,0.1);">
            <div style="font-size:12px; color:#ffd700; margin-bottom:6px;">最近交易（最多10笔）:</div>
            ${txHtml}
        </div>
    </div>`;
}

/** 渲染地址列表（模糊匹配） */
function renderAddressListResult(content, result, query) {
    const listHtml = result.addresses.map(a =>
        `<div class="search-address-item" onclick="searchAddress('${a.address}')">
            <span class="addr">${a.address}</span>
            <span><span class="bal">${formatBalance(a.balance)} STC</span> <span class="tx-count">(${a.txCount}笔)</span></span>
        </div>`
    ).join('');

    content.innerHTML = `<div class="search-result-card">
        <span class="search-result-type address-type">🔍 地址匹配</span>
        <button class="search-close-btn" onclick="closeSearchResults()">✕</button>
        <div class="search-hint">${escapeHtml(result.message)}</div>
        <div style="margin-top:8px;">
            ${listHtml}
        </div>
        ${result.total > 10 ? '<div class="search-hint">💡 显示前10个结果，请输入更精确的地址</div>' : ''}
    </div>`;
}

/** 渲染备注搜索结果 */
function renderNoteResult(content, result, query) {
    const txHtml = result.transactions.map(tx =>
        `<div class="search-tx-item tx-signed">
            <div>${shortAddr(tx.from, 10)} → ${shortAddr(tx.to, 10)}: <b>${tx.amount} STC</b>${tx.fee ? ' <span style="color:#f87171;">🔥费' + tx.fee + '</span>' : ''}</div>
            <div>区块 <a onclick="searchBlock('${tx.blockIndex}')" style="color:#60a5fa;cursor:pointer;">#${tx.blockIndex}</a> · <span class="tx-id" onclick="searchTxId('${tx.id}')">${shortAddr(tx.id, 20)}</span></div>
            <div style="color:#a855f7;">📝 ${escapeHtml(tx.note)}</div>
        </div>`
    ).join('');

    content.innerHTML = `<div class="search-result-card">
        <span class="search-result-type note-type">📝 备注搜索</span>
        <button class="search-close-btn" onclick="closeSearchResults()">✕</button>
        <div class="search-hint">${escapeHtml(result.message)}</div>
        <div class="search-tx-list" style="margin-top:8px;">
            ${txHtml}
        </div>
    </div>`;
}

/** 渲染交易池搜索结果 */
function renderMempoolResult(content, result, query) {
    const txHtml = result.transactions.map(tx =>
        `<div class="search-tx-item tx-pending">
            <div>⏳ ${shortAddr(tx.from, 10)} → ${shortAddr(tx.to, 10)}: <b>${tx.amount} STC</b>${tx.fee ? ' <span style="color:#f87171;">🔥费' + tx.fee + '</span>' : ''}</div>
            <div class="tx-id" onclick="searchTxId('${tx.id}')">${shortAddr(tx.id, 20)}</div>
            ${tx.note ? '<div style="color:#888;">📝 ' + escapeHtml(tx.note) + '</div>' : ''}
        </div>`
    ).join('');

    content.innerHTML = `<div class="search-result-card">
        <span class="search-result-type mempool-type">⏳ 交易池（待打包）</span>
        <button class="search-close-btn" onclick="closeSearchResults()">✕</button>
        <div class="search-hint">${escapeHtml(result.message)}</div>
        <div class="search-tx-list" style="margin-top:8px;">
            ${txHtml}
        </div>
    </div>`;
}

/** 按区块号搜索（供结果中的链接调用） */
function searchBlock(index) {
    const input = document.getElementById('searchInput');
    input.value = String(index);
    performSearch();
}

/** 按地址搜索（供结果中的链接调用） */
function searchAddress(address) {
    const input = document.getElementById('searchInput');
    input.value = address;
    performSearch();
}

/** 按交易ID搜索（供结果中的链接调用） */
function searchTxId(txId) {
    const input = document.getElementById('searchInput');
    input.value = txId;
    performSearch();
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
loadWallets();
renderWallets();
renderTransfer();
refreshAll();

// 连接 WebSocket，接收实时推送（新区块/新交易/链更新）
connectWebSocket();

// 备用轮询：每 60 秒刷新一次（WebSocket 断开时的兜底）
setInterval(() => {
    refreshMempool();
    refreshChain();
    refreshAddressRank();
}, 60000);