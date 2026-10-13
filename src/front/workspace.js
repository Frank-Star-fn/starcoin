/* Navigation and public view state. Wallet secrets stay in the existing keystore. */
function readActivity() {
    try { const items = JSON.parse(localStorage.getItem('starcoin_contract_activity') || '[]');
        return Array.isArray(items) ? items.filter(item => typeof item.id === 'string' && /^(0x)?[0-9a-f]{64}$/i.test(item.id)).slice(0, 50) : []; }
    catch { return []; }
}
const workspaceState = { blocks: [], blockPage: 0, activity: readActivity(), deployment: null };
const pageNames = { wallet: '钱包', contracts: '智能合约', explorer: '区块浏览器', node: '节点' };
function navigatePage(name, focus = true) {
    if (!Object.hasOwn(pageNames, name)) name = 'wallet';
    document.querySelectorAll('.workspace-page').forEach(page => { page.hidden = page.id !== 'page-' + name; });
    document.querySelectorAll('[data-page]').forEach(link => {
        if (link.dataset.page === name) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    document.title = 'StarCoin — ' + pageNames[name];
    if (location.hash !== '#' + name) history.pushState(null, '', '#' + name);
    if (focus) document.getElementById('title-' + name).focus({ preventScroll: true });
}
window.addEventListener('hashchange', () => navigatePage(location.hash.slice(1)));
window.addEventListener('popstate', () => navigatePage(location.hash.slice(1)));
function showContractTab(name) {
    if (!['deploy', 'call', 'receipts'].includes(name)) name = 'deploy';
    for (const tab of ['deploy', 'call', 'receipts']) {
        document.getElementById('contract-' + tab).hidden = tab !== name;
        const button = document.getElementById('tab-' + tab); button.setAttribute('aria-selected', String(tab === name)); button.tabIndex = tab === name ? 0 : -1;
    }
    updateContractGasVisibility();
}
function updateContractGasVisibility() {
    const receipt = document.getElementById('tab-receipts').getAttribute('aria-selected') === 'true';
    const call = document.getElementById('tab-call').getAttribute('aria-selected') === 'true';
    let readonly = false; try { readonly = ['view', 'pure'].includes(evmInterface().getFunction(document.getElementById('evmMethod').value)?.stateMutability); } catch {}
    document.getElementById('evmGasOptions').hidden = receipt || (call && readonly);
}
function closeWorkspaceDialog(id) { document.getElementById(id).close(); }
function openTransfer(index = state.selectedWallet) {
    navigatePage('wallet');
    if (!state.wallets[index]) { document.getElementById('walletEmpty').hidden = false; return; }
    document.getElementById('fromWallet').value = String(index); renderTransfer();
    const dialog = document.getElementById('transferDialog'); if (!dialog.open) dialog.showModal();
    document.getElementById('toAddress').focus();
}
function openReceive() {
    const wallet = state.wallets[state.selectedWallet]; if (!wallet) { navigatePage('wallet'); return; }
    document.getElementById('receiveAddress').textContent = wallet.address;
    document.getElementById('receiveMessage').textContent = '';
    document.getElementById('receiveDialog').showModal();
}
async function copyReceiveAddress() {
    try { await navigator.clipboard.writeText(document.getElementById('receiveAddress').textContent); document.getElementById('receiveMessage').textContent = '收款地址已复制'; }
    catch { document.getElementById('receiveMessage').textContent = '复制失败，请选中上方地址手动复制'; }
}
function toggleFunds() { const panel = document.getElementById('evmFunds'); panel.open = !panel.open; }
function updateWalletEmpty() { document.getElementById('walletEmpty').hidden = !!state.wallets[state.selectedWallet]; }
function setNodeConnection(connected) {
    const label = document.getElementById('nodeConnection'); if (label) { label.textContent = connected ? '● 节点已连接' : '○ 节点连接中'; label.style.color = connected ? '#79d4a4' : '#fbbf24'; }
}
function renderBlockList(blocks) {
    if (blocks) workspaceState.blocks = blocks;
    const reversed = [...workspaceState.blocks].reverse(), pages = Math.max(1, Math.ceil(reversed.length / 10));
    workspaceState.blockPage = Math.max(0, Math.min(workspaceState.blockPage, pages - 1));
    const visible = reversed.slice(workspaceState.blockPage * 10, workspaceState.blockPage * 10 + 10);
    const list = document.getElementById('chainVisual'); list.replaceChildren();
    for (const block of visible) {
        const row = textElement('button', '', 'block-row'); row.type = 'button';
        row.setAttribute('aria-label', '查看区块 ' + block.index);
        row.append(textElement('strong', '#' + block.index), textElement('code', shortAddr(block.hash, 28)),
            textElement('time', new Date(block.timestamp).toLocaleString()), textElement('span', (block.transactions?.length || 0) + ' 笔交易'));
        row.addEventListener('click', () => searchBlock(block.index)); list.append(row);
    }
    if (!visible.length) list.textContent = '暂无区块';
    document.getElementById('blockPageInfo').textContent = `共 ${reversed.length} 个区块 · 第 ${workspaceState.blockPage + 1} / ${pages} 页`;
    document.getElementById('blocksPrevious').disabled = workspaceState.blockPage === 0;
    document.getElementById('blocksNext').disabled = workspaceState.blockPage >= pages - 1;
}
function changeBlockPage(delta) { workspaceState.blockPage += delta; renderBlockList(); }
function persistActivity() {
    try { localStorage.setItem('starcoin_contract_activity', JSON.stringify(workspaceState.activity)); } catch { /* Public history remains available for this session. */ }
}
function trackContractTransaction(id, kind, artifact = null) {
    if (!workspaceState.activity.some(item => item.id === id)) workspaceState.activity.unshift({ id, kind, artifact, status: 'pending' });
    workspaceState.activity = workspaceState.activity.slice(0, 50); persistActivity(); renderContractActivity();
}
function renderContractActivity() {
    const list = document.getElementById('contractActivity');
    list.replaceChildren();
    if (!workspaceState.activity.length) { list.textContent = '暂无操作记录。部署、写入和资金操作提交后会显示在这里。'; return; }
    const kinds = { deploy: '部署', call: '合约交易', deposit: '存入', withdraw: '取回', transfer: 'EVM 转账' };
    const statuses = { pending: '待打包', unknown: '未找到', reverted: '已回滚', 0: '执行失败', 1: '执行成功' };
    for (const item of workspaceState.activity) {
        const button = document.createElement('button'); button.className = 'activity-row';
        const label = document.createElement('span'); label.textContent = `${kinds[item.kind] || '交易'} · ${statuses[item.status] || '待查询'}`;
        const hash = document.createElement('code'); hash.textContent = shortAddr(item.id, 24);
        button.append(label, hash); button.addEventListener('click', () => { document.getElementById('evmReceiptId').value = item.id; evmReceiptAction(); }); list.append(button);
    }
}
function recordContractReceipt(receipt, id) {
    const item = workspaceState.activity.find(record => record.id === id);
    if (item) { item.status = receipt.status; if (receipt.contractAddress && receipt.status === 1) item.address = receipt.contractAddress; else if (receipt.status !== 1) delete item.address; persistActivity(); }
    renderContractActivity(); updateSavedContracts();
    if (receipt.contractAddress && receipt.status === 1) {
        const fresh = workspaceState.deployment?.address !== receipt.contractAddress;
        workspaceState.deployment = { address: receipt.contractAddress, artifact: item?.artifact };
        document.getElementById('deploymentName').textContent = item?.artifact?.name || '合约';
        document.getElementById('deploymentAddress').textContent = receipt.contractAddress;
        if (fresh) document.getElementById('deploymentCard').hidden = false;
        try { if (!item?.artifact || JSON.stringify(item.artifact.abi) === JSON.stringify(JSON.parse(document.getElementById('evmAbi').value))) document.getElementById('artifactStatus').textContent = '部署成功，可以开始调用。'; } catch {}
    } else if (item?.kind === 'deploy') { document.getElementById('deploymentCard').hidden = true; }
}
function updateSavedContracts() {
    const select = document.getElementById('savedContract'), previous = select.value;
    select.replaceChildren(new Option('填写已有地址，或选择最近部署的合约', ''));
    const seen = new Set();
    for (const item of workspaceState.activity) if (item.address && item.artifact && !seen.has(item.address)) {
        seen.add(item.address); select.add(new Option((item.artifact.name || '合约') + ' · ' + shortAddr(item.address, 18), item.address));
    }
    select.value = previous;
}
function selectSavedContract(address) {
    const item = workspaceState.activity.find(record => record.address === address && record.artifact);
    if (!item) return;
    evmAction(async () => { evmUseArtifact({ contractName: item.artifact.name, abi: item.artifact.abi }); document.getElementById('evmContract').value = address; showContractTab('call'); });
}
function startContractCall() {
    const deployment = workspaceState.deployment; if (!deployment) return;
    evmAction(async () => { if (deployment.artifact) evmUseArtifact({ contractName: deployment.artifact.name, abi: deployment.artifact.abi }); document.getElementById('evmContract').value = deployment.address; showContractTab('call'); });
}
async function copyDeploymentAddress() {
    try { await navigator.clipboard.writeText(document.getElementById('deploymentAddress').textContent); document.getElementById('artifactStatus').textContent = '合约地址已复制'; }
    catch { document.getElementById('artifactStatus').textContent = '复制失败，请手动复制合约地址'; }
}
// Shared gas controls remain available for deployment and calls, without duplicate input IDs.
const gasDetails = document.createElement('details'); gasDetails.id = 'evmGasOptions'; gasDetails.className = 'advanced-options';
const gasSummary = document.createElement('summary'); gasSummary.textContent = '高级设置：Gas 上限与附带 STC';
gasDetails.append(gasSummary, document.querySelector('.evm-options'));
document.getElementById('evmResult').before(document.getElementById('deploymentCard'), gasDetails);
const toast = document.createElement('div'); toast.id = 'workspaceMessage'; toast.className = 'message'; toast.setAttribute('aria-live', 'polite'); document.body.append(toast);
const historyMore = document.createElement('button'); historyMore.id = 'walletHistoryMore'; historyMore.className = 'secondary'; historyMore.hidden = true; historyMore.addEventListener('click', () => showMoreWalletHistory()); document.getElementById('selectedWalletHistory').after(historyMore);
for (const group of document.querySelectorAll('[role="tablist"]')) group.addEventListener('keydown', event => {
    const tabs = [...group.querySelectorAll('[role="tab"]')], index = tabs.indexOf(document.activeElement);
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click(); tabs[next].focus();
});
navigatePage(location.hash.slice(1), false); showContractTab('deploy'); renderContractActivity(); updateSavedContracts();
