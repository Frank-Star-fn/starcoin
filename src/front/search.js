/* ============================================================
   搜索功能：按区块号、交易ID、地址、备注文本查询
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
                    <div>${prefix}: ${tx.from !== 'SYSTEM' ? shortAddr(tx.from, 10) + ' → ' : ''}${shortAddr(tx.to, 10)}: <b>${tx.amount} STC</b>${tx.fee ? ' <span style="color:#f87171;">🔥手续费 ' + formatBalance(tx.fee) + '</span>' : ''}</div>
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
            <span class="search-result-value" style="color:#f87171;">${formatBalance(result.totalBurnedFees)} STC</span>
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
            <span class="search-result-value" style="color:${result.confirmations >= 6 ? '#4ade80' : '#fbbf24'};">${status}</span>
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
            <span class="search-result-value" style="color:#f87171;">${formatBalance(tx.fee)} STC（已燃烧）</span>
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
                <div>${isReward ? '🎁 奖励' : '✍️ 转账'}: ${!isReward ? shortAddr(tx.from, 10) + ' → ' : ''}${shortAddr(tx.to, 10)}: <b>${tx.amount} STC</b>${tx.fee ? ' 🔥费' + formatBalance(tx.fee) : ''}</div>
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
            <div>${shortAddr(tx.from, 10)} → ${shortAddr(tx.to, 10)}: <b>${tx.amount} STC</b>${tx.fee ? ' <span style="color:#f87171;">🔥费' + formatBalance(tx.fee) + '</span>' : ''}</div>
            <div>区块 <a onclick="searchBlock('${tx.blockIndex}')" style="color:#60a5fa;cursor:pointer;">#${tx.blockIndex}</a> · <span class="tx-id" onclick="searchTxId('${tx.id}')" style="color:#60a5fa;cursor:pointer;font-family:monospace;">${shortAddr(tx.id, 20)}</span></div>
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
            <div>⏳ ${shortAddr(tx.from, 10)} → ${shortAddr(tx.to, 10)}: <b>${tx.amount} STC</b>${tx.fee ? ' <span style="color:#f87171;">🔥费' + formatBalance(tx.fee) + '</span>' : ''}</div>
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