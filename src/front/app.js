/* ============================================================
   状态管理
   ============================================================ */
const state = {
    wallets: [],      // [{label, encryptedPrivateKey, publicKey, address}]
    selectedWallet: -1
};

// 短暂忽略 WebSocket 推送的时间戳（毫秒）。
// 前端主动触发刷新（如挖矿成功）后，
// 在该时间窗口内忽略相同类型的 WS 推送，避免重复 API 调用耗尽限流配额。
let ignoreWsUntil = 0;
function setIgnoreWs(ms) { ignoreWsUntil = Date.now() + ms; }
function isWsIgnored() { return Date.now() < ignoreWsUntil; }

/* ============================================================
   全局防抖刷新（合并多源触发，避免 API 风暴）
   ============================================================ */
let _refreshTimer = null;
let _refreshLock = false;
let _refreshLockUntil = 0;

/**
 * 在 refreshAll 执行期间设置锁，防止 WS/SSE 重复触发
 * @param {number} ms - 锁定毫秒数
 */
function setRefreshLock(ms = 2000) {
    _refreshLockUntil = Date.now() + ms;
    _refreshLock = true;
}

/**
 * 检查是否处于刷新锁定期
 * @returns {boolean}
 */
function isRefreshLocked() {
    if (!_refreshLock) return false;
    if (Date.now() >= _refreshLockUntil) {
        _refreshLock = false;
        return false;
    }
    return true;
}

/**
 * 防抖版 refreshAll：在防抖窗口内合并多次触发为一次
 * @param {'high'|'normal'} priority - 'high' 立即执行但锁定后续，'normal' 合并等待
 */
function debouncedRefreshAll(priority = 'normal') {
    // 如果当前处于刷新锁定期，忽略本次请求
    if (isRefreshLocked()) return;

    if (_refreshTimer) clearTimeout(_refreshTimer);

    if (priority === 'high') {
        // 高优先级（挖矿成功）：立即执行，设置 500ms 锁定
        setRefreshLock(500);
        refreshAll();
        // 500ms 防抖窗口内不再响应新的触发
        _refreshTimer = setTimeout(() => {
            _refreshTimer = null;
        }, 500);
    } else {
        // 普通优先级：500ms 防抖窗口
        _refreshTimer = setTimeout(() => {
            _refreshTimer = null;
            if (isRefreshLocked()) return;
            refreshAll();
        }, 500);
    }
}

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
            // 更新 WS 活跃时间（供备用轮询判断是否跳过）
            if (typeof lastWsActivity !== 'undefined') {
                lastWsActivity = Date.now();
            }
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

/* ============================================================
   WebSocket 消息合并刷新队列
   ============================================================ */
let _pendingRefreshTypes = new Set();
let _pendingRefreshTimer = null;

/**
 * 将 WS 消息入队，在防抖窗口内合并同类刷新
 * @param {string} type - 消息类型
 */
function enqueueRefresh(type) {
    _pendingRefreshTypes.add(type);

    if (_pendingRefreshTimer) return;
    _pendingRefreshTimer = setTimeout(() => {
        _pendingRefreshTimer = null;

        if (isRefreshLocked() || isWsIgnored()) {
            _pendingRefreshTypes.clear();
            return;
        }

        // 根据合并后的消息类型决定刷新范围
        if (_pendingRefreshTypes.has('newBlock')) {
            // 包含新区块 → 全量刷新
            setRefreshLock(500);
            refreshAll();
        } else {
            // 仅新交易或链更新 → 局部刷新
            if (_pendingRefreshTypes.has('chainUpdated')) {
                refreshChain();
                refreshSelectedWalletDetails();
                updateFromBalanceHint();
            }
            if (_pendingRefreshTypes.has('newTransaction')) {
                refreshMempool();
            }
        }
        _pendingRefreshTypes.clear();
    }, 300); // 300ms 合并窗口
}

/**
 * 处理 WebSocket 推送消息
 */
function handleWsMessage(data) {
    // 前端刚刚主动刷新过（如挖矿成功）→ 短暂跳过 WS 触发的刷新
    if (isWsIgnored()) {
        return;
    }
    // 如果在防抖刷新锁定期内，忽略 WS 推送
    if (isRefreshLocked()) {
        return;
    }
    // 入队合并刷新
    enqueueRefresh(data.type);
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

/* ============================================================
   本地持久化（加密存储 format version 2）
   ============================================================ */

/**
 * 保存钱包数据到 localStorage（加密格式 version 2）
 * state.wallets 中的 encryptedPrivateKey 已由调用方写入，
 * 此处仅做序列化持久化
 */
function saveWallets() {
    try {
        const data = {
            version: 2,
            storageType: 'browser-key',
            wallets: state.wallets,
            selectedWallet: state.selectedWallet
        };
        localStorage.setItem('starcoin_wallets', JSON.stringify(data));
    } catch (e) {
        console.error('saveWallets error:', e);
    }
}

/** 从 localStorage 加载钱包，自动检测 v1/v2 格式并迁移 */
async function loadWallets() {
    try {
        // 确保主密钥就绪
        await getOrCreateMasterKey();

        const saved = localStorage.getItem('starcoin_wallets');
        if (!saved) return;

        const parsed = JSON.parse(saved);

        // version 2 格式（对象结构）
        if (parsed && typeof parsed === 'object' && parsed.version === 2) {
            state.wallets = Array.isArray(parsed.wallets) ? parsed.wallets : [];
            const sel = parsed.selectedWallet;
            if (sel !== undefined && sel !== null) {
                state.selectedWallet = Math.min(parseInt(sel), state.wallets.length - 1);
            }
            // 尝试验证第一个钱包是否能正常解密（检查密钥是否匹配）
            await verifyFirstWalletDecryption();
            return;
        }

        // version 1 格式（数组结构，包含明文 privateKey）
        if (Array.isArray(parsed)) {
            console.log('🔒 检测到旧格式钱包数据，正在加密迁移...');
            await migrateV1ToV2(parsed);
            saveWallets();
            console.log(`✅ 迁移完成：${state.wallets.length} 个私钥已加密存储`);
            return;
        }

        // 未知格式，忽略
        console.warn('loadWallets: 未知的钱包数据格式', typeof parsed);
    } catch (e) {
        console.error('loadWallets error:', e);
    }
}

/**
 * 尝试验证第一个钱包的解密，若失败则弹出密钥丢失提示
 */
async function verifyFirstWalletDecryption() {
    if (state.wallets.length === 0) return;
    const first = state.wallets[0];
    if (!first.encryptedPrivateKey) return;

    try {
        await decryptPrivateKey(first.encryptedPrivateKey);
    } catch (e) {
        // 解密失败 → 密钥不匹配
        console.warn('🔑 解密验证失败，主密钥已变更:', e.message);
        state.wallets = [];
        state.selectedWallet = -1;
        saveWallets();
        // 显示密钥丢失对话框
        showKeyMismatchDialog();
    }
}

/**
 * 从 v1（明文 privateKey）迁移到 v2（加密 encryptedPrivateKey）
 * @param {Array} oldWallets - v1 格式的钱包数组
 */
async function migrateV1ToV2(oldWallets) {
    const masterKey = await getOrCreateMasterKey();
    const newWallets = [];

    for (const w of oldWallets) {
        const pemText = w.privateKey;
        if (!pemText) {
            console.warn('迁移：钱包缺少 privateKey，跳过', w.label);
            continue;
        }
        const encrypted = await encryptPrivateKey(pemText, masterKey);
        newWallets.push({
            label: w.label,
            encryptedPrivateKey: encrypted,
            publicKey: w.publicKey,
            address: w.address
        });
    }

    state.wallets = newWallets;
    // 清空旧格式存储（已无明文 privateKey）
    localStorage.removeItem('starcoin_wallets_old');
}

/* ============================================================
   强制备份对话框
   ============================================================ */

let _forceBackupWalletIndex = -1; // 当前等待备份的钱包索引

/**
 * 显示强制备份对话框
 * @param {number} walletIndex - 钱包在 state.wallets 中的索引
 */
function showForceBackupDialog(walletIndex) {
    _forceBackupWalletIndex = walletIndex;
    const w = state.wallets[walletIndex];
    if (!w) return;

    const overlay = document.getElementById('forceBackupOverlay');
    const infoEl = document.getElementById('forceBackupWalletInfo');
    const riskConfirm = document.getElementById('forceBackupRiskConfirm');
    const downloadBtn = document.getElementById('forceBackupDownloadBtn');
    const laterBtn = document.getElementById('forceBackupLaterBtn');
    const confirmRiskBtn = document.getElementById('forceBackupConfirmRiskBtn');

    // 显示钱包信息
    infoEl.innerHTML = `
        <div>${escapeHtml(w.label)}</div>
        <div style="color:#aaa; font-size:10px;">${escapeHtml(w.address)}</div>
    `;

    // 重置状态
    riskConfirm.style.display = 'none';
    downloadBtn.disabled = false;
    laterBtn.disabled = false;

    // 下载按钮（内联导出，跳过 confirm 弹窗）
    downloadBtn.onclick = async () => {
        downloadBtn.disabled = true;
        downloadBtn.textContent = '⏳ 导出中...';
        try {
            const w = state.wallets[_forceBackupWalletIndex];
            if (!w) throw new Error('钱包已不存在');
            const masterKey = await getOrCreateMasterKey();
            const pemContent = await decryptPrivateKey(w.encryptedPrivateKey, masterKey);
            const shortAddrPart = w.address.substring(0, 8);
            const fileName = `starcoin_wallet_${shortAddrPart}.pem`;
            const blob = new Blob([pemContent], { type: 'application/x-pem-file' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            downloadBtn.textContent = '✅ 已下载';
            showMessage('txMessage', `✅ 备份已下载: ${fileName}\n📁 请妥善保管 .pem 文件`, 'success', 5000);
            setTimeout(() => { overlay.style.display = 'none'; }, 1200);
        } catch (err) {
            downloadBtn.textContent = '❌ 导出失败，重试';
            downloadBtn.disabled = false;
            showMessage('txMessage', '❌ 导出失败：' + err.message, 'error');
        }
    };

    // "稍后再说"按钮 → 显示风险确认
    laterBtn.onclick = () => {
        riskConfirm.style.display = 'block';
        laterBtn.disabled = true;
    };

    // "我已知晓风险"按钮 → 关闭对话框
    confirmRiskBtn.onclick = () => {
        overlay.style.display = 'none';
        _forceBackupWalletIndex = -1;
    };

    overlay.style.display = 'flex';
}

/* ============================================================
   密钥丢失提示对话框
   ============================================================ */

function showKeyMismatchDialog() {
    const overlay = document.getElementById('keyMismatchOverlay');
    const importBtn = document.getElementById('keyMismatchImportBtn');

    importBtn.onclick = () => {
        overlay.style.display = 'none';
        // 展开导入对话框
        const importDialog = document.getElementById('importKeyDialog');
        if (importDialog) importDialog.style.display = 'block';
    };

    overlay.style.display = 'flex';
}