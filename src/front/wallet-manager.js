/* ============================================================
   wallet-manager.js — 钱包业务逻辑 + 私钥导入/导出
   依赖：app.js + wallet-utils.js + wallet-ui.js + main.js + keystore.js
   ============================================================ */

/* ============================================================
   生成钱包
   ============================================================ */

/**
 * 请求后端生成新钱包，加密私钥后加入列表并刷新
 * 生成后强制要求导出 .pem 备份
 */
async function generateWallet() {
    try {
        const data = await api('/api/wallet/new', 'POST');
        if (!data.wallet) throw new Error('生成失败');

        // 加密私钥
        const encrypted = await encryptPrivateKey(data.wallet.privateKey);
        // data.wallet.privateKey 至此不再使用，退出函数后被 GC 回收

        const w = {
            label: '钱包 #' + (state.wallets.length + 1),
            encryptedPrivateKey: encrypted,
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

        // 强制备份
        showForceBackupDialog(state.wallets.length - 1);
    } catch (err) {
        showMessage('txMessage', '❌ 生成钱包失败：' + err.message, 'error');
    }
}

/* ============================================================
   选择钱包
   ============================================================ */

/**
 * 选中某个钱包，更新 UI 和本地持久化
 * @param {number} index - 钱包索引
 */
function selectWallet(index) {
    state.selectedWallet = index;
    renderWallets();
    renderTransfer();
    refreshSelectedWalletDetails();
    saveWallets();
}

/* ============================================================
   设为接收方
   ============================================================ */

/**
 * 将指定钱包地址填入转账表单的接收方输入框
 * @param {number} index - 钱包索引
 */
function setAsReceiver(index) {
    const w = state.wallets[index];
    if (!w) return;
    document.getElementById('toAddress').value = w.address;
    showMessage('txMessage', '📋 已将 ' + w.label + ' 设为接收方', 'info', 2000);
}

/* ============================================================
   删除钱包
   ============================================================ */

/**
 * 删除指定钱包（确认后执行）
 * @param {number} index - 钱包索引
 */
function removeWallet(index) {
    if (!confirm('确定删除 ' + state.wallets[index].label + '？私钥将无法恢复！')) return;
    state.wallets.splice(index, 1);
    if (state.selectedWallet >= state.wallets.length) state.selectedWallet = state.wallets.length - 1;
    renderWallets();
    renderTransfer();
    saveWallets();
}

/* ============================================================
   重命名钱包
   ============================================================ */

/**
 * 重命名钱包：内联编辑钱包标签
 * @param {number} index - 钱包索引
 */
function renameWallet(index) {
    const w = state.wallets[index];
    if (!w) return;

    // 找到对应的 wallet-item 元素中的 label 区域
    const walletItems = document.querySelectorAll('#walletList .wallet-item');
    const walletItem = walletItems[index];
    if (!walletItem) return;

    const labelEl = walletItem.querySelector('.wallet-label');
    if (!labelEl) return;

    const originalName = w.label;

    // 创建输入框替换 label 文本
    const input = document.createElement('input');
    input.type = 'text';
    input.value = originalName;
    input.className = 'rename-input';
    input.style.cssText = 'width:100%; padding:4px 6px; font-size:13px; border:1px solid #60a5fa; border-radius:4px; background:rgba(96,165,250,0.1); color:#fff; outline:none; box-sizing:border-box;';

    labelEl.textContent = '';
    labelEl.appendChild(input);
    input.focus();
    input.select();

    // 阻止点击输入框时 click 事件冒泡到 .wallet-item，防止触发 selectWallet 导致输入框被销毁
    input.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    function confirmRename() {
        const newName = input.value.trim();
        if (newName && newName !== originalName) {
            state.wallets[index].label = newName;
            saveWallets();
            renderWallets();
            renderTransfer();
        } else if (!newName) {
            // 名称为空则恢复原名，不触发刷新
            labelEl.textContent = originalName;
        } else {
            labelEl.textContent = originalName;
        }
    }

    function cancelRename() {
        labelEl.textContent = originalName;
    }

    input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
            e.preventDefault();
            confirmRename();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelRename();
        }
    });

    input.addEventListener('blur', () => {
        // 延迟确认，避免点击其他按钮时触发的 blur 与按钮 click 冲突
        setTimeout(confirmRename, 180);
    });
}

/* ============================================================
   复制当前选中钱包地址
   ============================================================ */

function copySelectedAddress() {
    const w = state.wallets[state.selectedWallet];
    if (!w) return;
    navigator.clipboard.writeText(w.address).then(() => {
        showMessage('txMessage', '📋 地址已复制到剪贴板', 'success', 2000);
    });
}

/* ============================================================
   私钥导出：解密后下载 PEM 文件（纯前端，不经过网络）
   ============================================================ */

/**
 * 导出指定钱包的私钥为 .pem 文件
 * 解密成功后立即下载，内存中的明文在函数退出后由 GC 回收
 * @param {number} index - 钱包索引
 */
async function exportPrivateKey(index) {
    const w = state.wallets[index];
    if (!w) return;

    // 安全确认
    if (!confirm(`⚠️  即将导出私钥！\n\n钱包: ${w.label}\n地址: ${shortAddr(w.address, 20)}\n\n持有私钥即可完全控制该钱包中的资产。\n请确保在安全的环境下操作。\n\n确认导出吗？`)) {
        throw new Error('用户取消导出');
    }

    // 解密私钥（局部变量，不存回 state）
    const masterKey = await getOrCreateMasterKey();
    const pemContent = await decryptPrivateKey(w.encryptedPrivateKey, masterKey);

    // 构建 .pem 文件内容
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
   私钥导入（旧版：内联区域）
   ============================================================ */

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
 * 执行私钥导入（旧版文本输入区）
 * 后端验证通过后，前端加密存储 privateKey
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

        // 加密私钥
        const encrypted = await encryptPrivateKey(w.privateKey);

        state.wallets.push({
            label: '钱包 #' + (state.wallets.length + 1) + ' (导入)',
            encryptedPrivateKey: encrypted,
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
   私钥导入（新版：对话框 + 文件选择）
   ============================================================ */

/**
 * 显示私钥导入对话框
 */
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

/**
 * 隐藏私钥导入对话框
 */
function hideImportKeyDialog() {
    document.getElementById('importKeyDialog').style.display = 'none';
}

/**
 * 执行私钥导入（新版：支持 PEM 文本粘贴或文件选择）
 * 后端验证通过后，前端加密存储 privateKey
 */
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

            // 加密私钥
            const encrypted = await encryptPrivateKey(w.privateKey);

            // 添加到钱包列表
            const walletEntry = {
                label: '钱包 #' + (state.wallets.length + 1) + '（导入）',
                encryptedPrivateKey: encrypted,
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