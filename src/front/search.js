/* Chain data is always rendered as text, including old arbitrary addresses. */
function textElement(tag, text, className = '') {
    const element = document.createElement(tag);
    element.className = className; element.textContent = text == null ? '' : String(text);
    return element;
}
function searchLink(label, action, value) {
    const link = textElement('button', label, 'search-link'); link.type = 'button';
    link.addEventListener('click', () => action(value)); return link;
}
function searchCard(content, title, type = '') {
    const card = textElement('div', '', 'search-result-card');
    card.append(textElement('span', title, 'search-result-type ' + type));
    const close = textElement('button', '✕', 'search-close-btn'); close.type = 'button';
    close.addEventListener('click', closeSearchResults); card.append(close);
    content.replaceChildren(card); return card;
}
function searchRow(card, label, value, action, target = value) {
    const row = textElement('div', '', 'search-result-row');
    row.append(textElement('span', label, 'search-result-label'));
    const output = textElement('span', '', 'search-result-value');
    output.append(action ? searchLink(value, action, target) : document.createTextNode(String(value ?? '')));
    row.append(output); card.append(row);
}
function searchTransactions(card, transactions = [], includeBlock = false) {
    const list = textElement('div', '', 'search-tx-list');
    for (const tx of transactions) {
        const reward = !tx.from || tx.from === 'SYSTEM';
        const item = textElement('div', '', 'search-tx-item ' + (reward ? 'tx-reward' : 'tx-signed'));
        const display = typeof transactionDisplay === 'function' ? transactionDisplay(tx) : { amount: tx.amount, label: tx.currency || 'STC' };
        item.append(textElement('div', `${reward ? '🎁 奖励' : shortAddr(tx.from, 10) + ' →'} ${shortAddr(tx.to, 10)}: ${display.amount} ${display.label}${tx.fee ? ' · 手续费 ' + formatBalance(tx.fee) : ''}`));
        item.append(searchLink(shortAddr(tx.id, 24), searchTxId, tx.id));
        if (includeBlock && tx.blockIndex != null) item.append(searchLink('区块 #' + tx.blockIndex, searchBlock, tx.blockIndex));
        if (tx.note) item.append(textElement('div', '备注: ' + tx.note));
        list.append(item);
    }
    if (!transactions.length) list.textContent = '暂无交易记录';
    card.append(list);
}
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('searchInput')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); performSearch(); }
    });
});
async function performSearch() {
    if (typeof navigatePage === 'function') navigatePage('explorer');
    const query = (document.getElementById('searchInput').value || '').trim();
    if (!query) { closeSearchResults(); return; }
    const panel = document.getElementById('searchResults'), content = document.getElementById('searchResultsContent');
    panel.style.display = 'block'; content.textContent = '搜索中...';
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try { renderSearchResults(await api('/api/search?q=' + encodeURIComponent(query))); }
    catch (error) { searchCard(content, '❌ 错误').append(textElement('div', '搜索请求失败: ' + error.message)); }
}
function closeSearchResults() { document.getElementById('searchResults').style.display = 'none'; }
function renderSearchResults(data) {
    const content = document.getElementById('searchResultsContent');
    if (!data?.success) { searchCard(content, '❌ 错误').append(textElement('div', '搜索失败: ' + (data?.error || '未知错误'))); return; }
    const render = { block: renderBlockResult, transaction: renderTxResult, address: renderAddressResult,
        address_list: renderAddressListResult, note: renderNoteResult, mempool: renderMempoolResult }[data.type];
    if (render) render(content, data.result);
    else {
        const card = searchCard(content, '🔍 搜索结果');
        card.append(textElement('div', data.result?.message || '请输入区块号、交易 ID、地址或备注'));
        if (data.result?.hint) card.append(textElement('div', data.result.hint, 'search-hint'));
    }
}
function renderBlockResult(content, result) {
    const block = result.block, card = searchCard(content, '📦 区块', 'block-type');
    searchRow(card, '区块高度', '#' + block.index);
    searchRow(card, '区块哈希', block.hash); searchRow(card, '前驱哈希', block.previousHash);
    searchRow(card, '时间戳', new Date(block.timestamp).toLocaleString()); searchRow(card, 'Nonce', block.nonce);
    searchRow(card, '包含交易数', result.transactionCount);
    if (result.totalBurnedFees > 0) searchRow(card, '🔥 本块燃烧手续费', formatBalance(result.totalBurnedFees) + ' STC');
    searchTransactions(card, block.transactions);
}
function renderTxResult(content, result) {
    const tx = result.transaction, card = searchCard(content, '✍️ 交易', 'tx-type');
    searchRow(card, '交易 ID', tx.id);
    searchRow(card, '所在区块', result.blockIndex == null ? '尚未进入当前主链' : '#' + result.blockIndex,
        result.blockIndex == null ? undefined : searchBlock, result.blockIndex);
    const statuses = { confirmed: '✅ 已达到确认阈值', pending: '⏳ 待打包', reverted: '⚠️ 已被链重组回滚' };
    searchRow(card, '确认数', `${statuses[result.status] || '⏳ 已入块'} (${result.confirmations || 0}/${result.requiredConfirmations || 0})`);
    searchRow(card, '发送方', tx.from || 'SYSTEM', searchAddress);
    searchRow(card, '接收方', tx.to, searchAddress);
    searchRow(card, '金额', `${tx.amount} ${tx.currency || 'STC'}`);
    if (tx.fee) searchRow(card, '🔥 手续费', formatBalance(tx.fee) + ' STC（已燃烧）');
    if (tx.note) searchRow(card, '备注', tx.note);
    if (tx.signature) searchRow(card, '签名', shortAddr(tx.signature, 32));
}
function renderAddressResult(content, result) {
    const card = searchCard(content, '💼 地址', 'address-type');
    searchRow(card, '地址', result.address); searchRow(card, '余额（可用）', formatBalance(result.balance) + ' STC');
    if (result.lockedRewards > 0) searchRow(card, '🔒 锁定奖励', formatBalance(result.lockedRewards) + ' STC');
    if (result.totalBalance != null) searchRow(card, '总余额（含锁定）', formatBalance(result.totalBalance) + ' STC');
    searchRow(card, '交易总数', result.transactionCount);
    searchRow(card, '待确认交易', result.pendingTransactions || 0);
    searchTransactions(card, result.transactions);
}
function renderAddressListResult(content, result) {
    const card = searchCard(content, '🔍 地址匹配', 'address-type');
    card.append(textElement('div', result.message, 'search-hint'));
    for (const address of result.addresses || []) {
        const row = textElement('div', '', 'search-address-item');
        row.append(searchLink(address.address, searchAddress, address.address));
        row.append(textElement('span', `${formatBalance(address.balance)} STC (${address.txCount} 笔)`));
        card.append(row);
    }
    if (result.total > 10) card.append(textElement('div', '显示前 10 个结果，请输入更精确的地址', 'search-hint'));
}
function renderNoteResult(content, result) {
    const card = searchCard(content, '📝 备注搜索', 'note-type');
    card.append(textElement('div', result.message, 'search-hint')); searchTransactions(card, result.transactions, true);
}
function renderMempoolResult(content, result) {
    const card = searchCard(content, '⏳ 交易池', 'mempool-type');
    card.append(textElement('div', result.message, 'search-hint')); searchTransactions(card, result.transactions);
}
function searchBlock(index) { document.getElementById('searchInput').value = String(index); performSearch(); }
function searchAddress(address) { document.getElementById('searchInput').value = address; performSearch(); }
function searchTxId(id) { document.getElementById('searchInput').value = id; performSearch(); }
