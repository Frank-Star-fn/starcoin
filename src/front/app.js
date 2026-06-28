/* ============================================================
   状态管理
   ============================================================ */
const state = {
    wallets: [],      // [{label, privateKey, publicKey, address}]
    selectedWallet: -1
};

// 短暂忽略 WebSocket 推送的时间戳（毫秒）。
// 前端主动触发刷新（如挖矿成功）后，
// 在该时间窗口内忽略相同类型的 WS 推送，避免重复 API 调用耗尽限流配额。
let ignoreWsUntil = 0;
function setIgnoreWs(ms) { ignoreWsUntil = Date.now() + ms; }
function isWsIgnored() { return Date.now() < ignoreWsUntil; }

/* ============================================================
   WebSocket 实时推送（替代轮询）
   ============================================================ */
let wsReconnectTimer = null;

function connectWebSocket() {
    // 清除之前的重连定时器
    if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    console.log(`🔌 WebSocket 正在连接: ${wsUrl}`);

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('✅ WebSocket 已连接');
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleWsMessage(data);
        } catch (err) {
            console.error('❌ WebSocket 消息解析失败:', err);
        }
    };

    ws.onclose = () => {
        console.log('🔌 WebSocket 连接关闭，5秒后重连...');
        wsReconnectTimer = setTimeout(() => {
            connectWebSocket();
        }, 5000);
    };

    ws.onerror = (err) => {
        console.error('❌ WebSocket 错误:', err);
        ws.close();
    };
}

/**
 * 处理 WebSocket 推送消息
 */
function handleWsMessage(data) {
    // 前端刚刚主动刷新过（如挖矿成功）→ 短暂跳过 WS 触发的刷新
    if (isWsIgnored()) {
        console.log(`🎯 WS推送（已忽略·主动刷新窗口内）: ${data.type}`);
        return;
    }
    switch (data.type) {
        case 'newBlock':
            // 新区块到达 → 刷新链、交易池、地址榜
            console.log(`🎯 WS推送: 新区块 #${data.blockIndex}`);
            refreshChain();
            refreshMempool();
            refreshAddressRank();
            // 也刷新钱包详情（余额可能变化）
            refreshSelectedWalletDetails();
            updateFromBalanceHint();
            break;

        case 'newTransaction':
            // 新交易到达 → 刷新交易池
            console.log('🎯 WS推送: 新交易到达');
            refreshMempool();
            break;

        case 'chainUpdated':
            // 链数据变更（P2P 同步引起）→ 全面刷新
            console.log('🎯 WS推送: 链数据已更新（P2P同步）');
            refreshChain();
            refreshMempool();
            refreshAddressRank();
            refreshSelectedWalletDetails();
            updateFromBalanceHint();
            break;

        default:
            console.log('🎯 WS推送: 未知类型', data.type);
    }
}

/* ============================================================
   工具函数
   ============================================================ */
async function api(path, method = 'GET', body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);

    // 限流（429）或其他非 2xx 状态 → 抛出带信息的错误
    // 让调用方有机会识别"请求过于频繁"并退避重试，而不是当成正常数据解析
    if (!res.ok) {
        let payload = null;
        try { payload = await res.json(); } catch (_) { /* 非 JSON 响应体 */ }
        const err = new Error(
            (payload && payload.error) || `HTTP ${res.status}`
        );
        err.statusCode = res.status;
        err.code = (payload && payload.code) || 'HTTP_ERROR';
        err.details = (payload && payload.details) || null;
        err.raw = payload;
        // 标记是否为限流，方便调用方做退避逻辑
        err.isRateLimit = res.status === 429;
        // Retry-After 秒数（可能为 null）
        const retryAfter = res.headers.get('Retry-After');
        err.retryAfterSec = retryAfter ? parseInt(retryAfter, 10) : null;
        throw err;
    }
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