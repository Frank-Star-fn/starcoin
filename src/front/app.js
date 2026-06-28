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

/* ============================================================
   本地持久化（加密存储格式）
   版本说明：
     v1（旧）：JSON 数组，wallets[i].privateKey 为明文 PEM
     v2（当前）：{ version: 2, storageType: "browser-key", wallets, selectedWallet }
               wallets[i].encryptedPrivateKey 为加密数据
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

/**
 * 从 localStorage 加载钱包数据
 * 自动检测格式并迁移：
 *   - v2（对象，version==2）：直接加载
 *   - v1（数组，含 privateKey 明文）：触发加密迁移
 *   解密失败（密钥丢失）时显示提示并清空钱包列表
 */
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