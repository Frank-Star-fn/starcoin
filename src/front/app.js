/* ============================================================
   状态管理
   ============================================================ */
const state = {
    wallets: [],      // [{label, privateKey, publicKey, address}]
    selectedWallet: -1
};

/* ============================================================
   工具函数
   ============================================================ */
async function api(path, method = 'GET', body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    return await res.json();
}

function shortAddr(addr, len = 12) {
    if (!addr) return '';
    return addr.length > len ? addr.substring(0, len) + '...' : addr;
}

function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function showMessage(id, text, type = 'info', timeoutMs = 3500) {
    const el = document.getElementById(id);
    el.className = 'message ' + type;
    el.textContent = text;
    if (timeoutMs > 0) {
        clearTimeout(el._timer);
        el._timer = setTimeout(() => { el.className = 'message'; el.textContent = ''; }, timeoutMs);
    }
}

function clearMessage(id) {
    const el = document.getElementById(id);
    el.className = 'message';
    el.textContent = '';
}

/* 本地持久化 */
function saveWallets() {
    try {
        localStorage.setItem('starcoin_wallets', JSON.stringify(state.wallets));
        localStorage.setItem('starcoin_selected', String(state.selectedWallet));
    } catch (e) {}
}

function loadWallets() {
    try {
        const saved = localStorage.getItem('starcoin_wallets');
        if (saved) state.wallets = JSON.parse(saved);
        const sel = localStorage.getItem('starcoin_selected');
        if (sel !== null) state.selectedWallet = Math.min(parseInt(sel), state.wallets.length - 1);
    } catch (e) {}
}