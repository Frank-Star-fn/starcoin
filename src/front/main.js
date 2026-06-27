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
            let txt = '可用余额: ' + (data.balance || 0) + ' STC';
            if (data.lockedRewards > 0) {
                txt += '（🔒 ' + data.lockedRewards + ' 奖励锁定中，共 ' + (data.totalBalance || 0) + ' STC）';
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

async function mineBlock() {
    const btn = document.getElementById('mineBtn');
    const minerAddr = document.getElementById('minerAddress').value.trim();
    const animContainer = document.getElementById('miningAnimation');
    const nonceDisplay = document.getElementById('miningNonce');
    const hashDisplay = document.getElementById('miningHash');
    const progressBar = document.getElementById('miningProgress');
    const statusText = document.getElementById('miningStatus');
    const difficultyDisplay = document.getElementById('miningDifficulty');

    if (!minerAddr) { showMessage('txMessage', '❌ 请先选择或填写矿工奖励地址', 'error'); return; }

    // 禁用按钮
    btn.disabled = true;
    btn.textContent = '⛏️ 挖矿中...';

    // 显示动画区域
    animContainer.style.display = 'block';
    animContainer.className = 'mining-animation mining-active';
    nonceDisplay.textContent = '0';
    hashDisplay.textContent = '计算中...';
    progressBar.style.width = '0%';
    statusText.textContent = '⛏️ 正在寻找满足条件的 nonce...';
    showMessage('txMessage', '', 'info', 0);

    // 用于统计
    let lastNonce = 0;
    let startTime = Date.now();

    // 使用 EventSource (SSE) 接收挖矿进度
    const url = `/api/mine/stream?minerAddress=${encodeURIComponent(minerAddr)}`;
    const eventSource = new EventSource(url);
    let miningCompleted = false;

    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            if (data.started) {
                // 开始挖矿
                statusText.textContent = data.message || '⛏️ 正在寻找满足条件的 nonce...';
                if (data.difficulty != null) {
                    difficultyDisplay.textContent = data.difficulty;
                }
                return;
            }

            if (data.found) {
                // 挖矿完成！
                miningCompleted = true;
                eventSource.close();

                if (data.nonce != null) {
                    nonceDisplay.textContent = Number(data.nonce).toLocaleString();
                }
                if (data.difficulty != null) {
                    difficultyDisplay.textContent = data.difficulty;
                }
                if (data.hash) hashDisplay.textContent = data.hash;
                progressBar.style.width = '100%';
                animContainer.className = 'mining-animation mining-success';
                statusText.textContent = data.message || '🎉 挖矿成功！';

                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                if (data.block && data.block.index != null) {
                    showMessage('txMessage', `🎉 挖矿成功！区块 #${data.block.index} 已生成，耗时 ${elapsed}s，nonce: ${data.nonce}`, 'success', 5000);
                }

                // 恢复按钮（确保在所有路径下都执行）
                enableMineButton();
                btn.disabled = false;
                btn.textContent = '⛏️ 开始挖矿并打包交易';

                // 8 秒后隐藏动画
                setTimeout(() => {
                    if (!document.querySelector('.mining-success')) return;
                    animContainer.style.display = 'none';
                    animContainer.className = 'mining-animation';
                }, 8000);

                refreshAll();
                return;
            }

            if (data.error) {
                miningCompleted = true;
                eventSource.close();
                statusText.textContent = '❌ ' + data.error;
                animContainer.className = 'mining-animation mining-error';
                enableMineButton();
                showMessage('txMessage', '❌ ' + data.error, 'error');
                return;
            }

            // 进度更新
            if (data.nonce) {
                nonceDisplay.textContent = Number(data.nonce).toLocaleString();
                if (data.difficulty != null) difficultyDisplay.textContent = data.difficulty;
                if (data.hash) hashDisplay.textContent = data.hash;

                // 简单的进度估算：当前 hash 的前缀匹配程度
                // 注意：data.target 可能含小数约束字符（如 "00000(≤0x7f)"），
                //       因此改用 data.difficulty 计算前缀零数
                if (data.hash && data.difficulty != null) {
                    const prefixLen = Math.floor(Number(data.difficulty));
                    let matchLen = 0;
                    for (let i = 0; i < prefixLen && i < data.hash.length; i++) {
                        if (data.hash[i] === '0') matchLen++;
                        else break;
                    }
                    const baseLen = Math.max(1, prefixLen);
                    let pct = (matchLen / baseLen) * 100;
                    // 加上小数部分的微进度（如果当前已满足整数前缀零）
                    if (matchLen === prefixLen && Number(data.difficulty) - prefixLen > 0) {
                        const nextByteHex = data.hash.substring(prefixLen, prefixLen + 2);
                        const nextByteVal = parseInt(nextByteHex, 16);
                        const maxNextByte = Math.floor((Number(data.difficulty) - prefixLen) * 256);
                        if (!isNaN(nextByteVal) && maxNextByte > 0) {
                            const fracPct = Math.min(100, (nextByteVal / maxNextByte) * 100);
                            pct = pct + (fracPct / baseLen) * 0.5;
                        }
                    }
                    pct = Math.min(95, Math.max(1, pct));
                    progressBar.style.width = pct + '%';
                }

                // 计算哈希速率
                const elapsed = (Date.now() - startTime) / 1000;
                if (elapsed > 0) {
                    const rate = Math.round(Number(data.nonce) / elapsed);
                    statusText.textContent = `⛏️ 哈希率: ${rate.toLocaleString()} hashes/秒  |  已尝试: ${Number(data.nonce).toLocaleString()} 次`;
                }
            }
        } catch (err) {
            console.error('挖矿 SSE 消息处理出错:', err);
            // 出错时也尝试恢复按钮
            enableMineButton();
        }
    };

    eventSource.onerror = () => {
        if (!miningCompleted) {
            eventSource.close();
            statusText.textContent = '❌ 连接中断';
            animContainer.className = 'mining-animation mining-error';
            enableMineButton();
            showMessage('txMessage', '❌ 挖矿连接中断，请重试', 'error');
        }
    };
}

    // 辅助函数：恢复挖矿按钮（全局可用，供自动挖矿调用）
function enableMineButton() {
    try {
        const mineBtn = document.getElementById('mineBtn');
        if (mineBtn) {
            mineBtn.disabled = false;
            mineBtn.textContent = '⛏️ 开始挖矿并打包交易';
        }
    } catch (e) { /* ignore */ }
}

/* ============================================================
   自动持续挖矿
   ============================================================ */
// 自动挖矿全局状态
const autoMineState = {
    active: false,           // 是否正在自动挖矿
    blocksMined: 0,          // 本轮已挖区块数
    startTime: 0,            // 本轮开始时间
    currentNonce: 0,         // 当前挖矿的 nonce
    currentHash: '',         // 当前挖矿的 hash
    minerAddress: '',        // 矿工地址
    timeoutId: null          // 下次挖矿的延时句柄
};

async function toggleAutoMine() {
    const btn = document.getElementById('autoMineBtn');
    const statusEl = document.getElementById('autoMineStatus');
    const animContainer = document.getElementById('miningAnimation');

    if (autoMineState.active) {
        // === 停止自动挖矿 ===
        autoMineState.active = false;
        if (autoMineState.timeoutId) {
            clearTimeout(autoMineState.timeoutId);
            autoMineState.timeoutId = null;
        }
        btn.className = 'secondary';
        btn.textContent = '⏱️ 自动持续挖矿';
        statusEl.style.display = 'none';

        // 恢复普通挖矿按钮
        enableMineButton();
        // 如果有正在运行的 SSE，浏览器会在 tab 关闭/重连时自动断开
        // 我们不需要手动干预 EventSource，因为每个 mineBlock 创建新的

        showMessage('txMessage', '⏸️ 自动挖矿已停止（共挖了 ' + autoMineState.blocksMined + ' 个区块）', 'info', 3000);
        return;
    }

    // === 启动自动挖矿 ===
    const minerAddr = document.getElementById('minerAddress').value.trim();
    if (!minerAddr) {
        showMessage('txMessage', '❌ 请先选择或填写矿工奖励地址', 'error');
        return;
    }

    // 初始化状态
    autoMineState.active = true;
    autoMineState.blocksMined = 0;
    autoMineState.startTime = Date.now();
    autoMineState.minerAddress = minerAddr;

    // 显示自动挖矿状态栏
    statusEl.style.display = 'block';
    statusEl.innerHTML = '<span style="color:#4ade80;">⏱️ 自动挖矿中...</span> <span id="autoMineCounter">已挖 0 个区块</span>';
    btn.className = 'danger';
    btn.textContent = '⏹️ 停止自动挖矿';

    showMessage('txMessage', '🚀 自动挖矿已启动！每次挖矿成功后自动开始下一次', 'info', 3000);

    // 立即开始第一轮
    await startNextAutoMine();
}

async function startNextAutoMine() {
    if (!autoMineState.active) return;

    const animContainer = document.getElementById('miningAnimation');
    const nonceDisplay = document.getElementById('miningNonce');
    const hashDisplay = document.getElementById('miningHash');
    const progressBar = document.getElementById('miningProgress');
    const statusText = document.getElementById('miningStatus');
    const difficultyDisplay = document.getElementById('miningDifficulty');
    const btn = document.getElementById('mineBtn');

    // 禁用单次挖矿按钮
    btn.disabled = true;
    btn.textContent = '⏱️ 自动挖矿中...';

    // 显示/更新挖矿动画
    animContainer.style.display = 'block';
    animContainer.className = 'mining-animation mining-active';
    nonceDisplay.textContent = '0';
    hashDisplay.textContent = '计算中...';
    progressBar.style.width = '0%';
    statusText.textContent = '⛏️ 自动挖矿中...';

    // 更新状态栏
    const counterEl = document.getElementById('autoMineCounter');
    if (counterEl) {
        const elapsed = ((Date.now() - autoMineState.startTime) / 1000).toFixed(0);
        const avgTime = autoMineState.blocksMined > 0
            ? (elapsed / autoMineState.blocksMined).toFixed(1)
            : '--';
        counterEl.textContent = `已挖 ${autoMineState.blocksMined} 个区块 | 总耗时 ${elapsed}s | 平均 ${avgTime}s/块`;
    }

    const startTime = Date.now();
    const url = `/api/mine/stream?minerAddress=${encodeURIComponent(autoMineState.minerAddress)}`;
    const eventSource = new EventSource(url);
    let miningCompleted = false;

    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            if (data.started) {
                statusText.textContent = data.message || '⛏️ 自动挖矿中...';
                if (data.difficulty != null) difficultyDisplay.textContent = data.difficulty;
                return;
            }

            if (data.found) {
                miningCompleted = true;
                eventSource.close();

                // 更新显示
                if (data.nonce != null) nonceDisplay.textContent = Number(data.nonce).toLocaleString();
                if (data.difficulty != null) difficultyDisplay.textContent = data.difficulty;
                if (data.hash) hashDisplay.textContent = data.hash;
                progressBar.style.width = '100%';
                animContainer.className = 'mining-animation mining-success';
                statusText.textContent = '🎉 区块 #' + (data.block && data.block.index != null ? data.block.index : '?') + ' 挖矿成功！';

                // 刷新数据
                refreshAll();

                // 计数
                autoMineState.blocksMined++;

                // 如果仍然活跃，等 500ms 后自动开始下一次
                if (autoMineState.active) {
                    autoMineState.timeoutId = setTimeout(() => {
                        if (autoMineState.active) {
                            startNextAutoMine();
                        }
                    }, 500);
                } else {
                    // 已被停止
                    enableMineButton();
                    animContainer.style.display = 'none';
                }
                return;
            }

            if (data.error) {
                miningCompleted = true;
                eventSource.close();
                statusText.textContent = '❌ ' + data.error;
                animContainer.className = 'mining-animation mining-error';
                stopAutoMineOnError(data.error);
                return;
            }

            // 进度更新
            if (data.nonce) {
                nonceDisplay.textContent = Number(data.nonce).toLocaleString();
                if (data.difficulty != null) difficultyDisplay.textContent = data.difficulty;
                if (data.hash) hashDisplay.textContent = data.hash;

                // 自动挖矿进度：基于 difficulty 计算前缀零匹配（兼容小数难度）
                if (data.hash && data.difficulty != null) {
                    const prefixLen = Math.floor(Number(data.difficulty));
                    let matchLen = 0;
                    for (let i = 0; i < prefixLen && i < data.hash.length; i++) {
                        if (data.hash[i] === '0') matchLen++;
                        else break;
                    }
                    const baseLen = Math.max(1, prefixLen);
                    let pct = (matchLen / baseLen) * 100;
                    if (matchLen === prefixLen && Number(data.difficulty) - prefixLen > 0) {
                        const nextByteHex = data.hash.substring(prefixLen, prefixLen + 2);
                        const nextByteVal = parseInt(nextByteHex, 16);
                        const maxNextByte = Math.floor((Number(data.difficulty) - prefixLen) * 256);
                        if (!isNaN(nextByteVal) && maxNextByte > 0) {
                            const fracPct = Math.min(100, (nextByteVal / maxNextByte) * 100);
                            pct = pct + (fracPct / baseLen) * 0.5;
                        }
                    }
                    pct = Math.min(95, Math.max(1, pct));
                    progressBar.style.width = pct + '%';
                }

                const elapsed = (Date.now() - startTime) / 1000;
                if (elapsed > 0) {
                    const rate = Math.round(Number(data.nonce) / elapsed);
                    statusText.textContent = `⏱️ 自动挖矿 | 哈希率: ${rate.toLocaleString()} hashes/秒 | 已尝试: ${Number(data.nonce).toLocaleString()} 次`;
                }
            }
        } catch (err) {
            console.error('自动挖矿 SSE 处理出错:', err);
            if (!miningCompleted) {
                eventSource.close();
                stopAutoMineOnError(err.message);
            }
        }
    };

    eventSource.onerror = () => {
        if (!miningCompleted && autoMineState.active) {
            eventSource.close();
            stopAutoMineOnError('连接中断');
        }
    };
}

function stopAutoMineOnError(errMsg) {
    autoMineState.active = false;
    if (autoMineState.timeoutId) {
        clearTimeout(autoMineState.timeoutId);
        autoMineState.timeoutId = null;
    }

    const btn = document.getElementById('autoMineBtn');
    if (btn) {
        btn.className = 'secondary';
        btn.textContent = '⏱️ 自动持续挖矿';
    }

    const statusEl = document.getElementById('autoMineStatus');
    if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.innerHTML = '<span style="color:#f87171;">❌ 自动挖矿出错: ' + errMsg + '</span>';
    }

    enableMineButton();
    showMessage('txMessage', '❌ 自动挖矿出错: ' + errMsg + '，请重试', 'error');
}

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
                        ${tx.fee ? '(+ 费 ' + tx.fee + ')' : ''}
                    </div>
                    ${tx.note ? '<div style="color:#888; font-size:11px; margin-top:3px;">备注: ' + escapeHtml(tx.note) + '</div>' : ''}
                    <div style="color:#666; font-size:10px; margin-top:3px; font-family:monospace;">txid: ${shortAddr(tx.id, 20)}</div>
                    ${tx.signature ? '<div style="color:#4ade80; font-size:10px; margin-top:2px;">✅ 已 ECDSA 签名</div>' : ''}
                </div>
            `).join('');
        }
    } catch (e) {
        document.getElementById('mempool').textContent = '查询失败';
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
                    <span class="bal">${a.balance} STC</span>
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
            const txList = (b.transactions || []).map(tx => {
                let cls = 'block-tx ';
                let prefix = '';
                if (tx.from === 'SYSTEM' || !tx.from) { cls += 'reward'; prefix = '🎁 '; }
                else if (tx.signature) { cls += 'signed'; prefix = '✍️ '; }
                else { cls += 'unsigned'; prefix = '⚠ '; }

                if (tx.from === 'SYSTEM') {
                    return `<div class="${cls}">${prefix}奖励 → ${shortAddr(tx.to, 10)}: ${tx.amount} STC</div>`;
                }
                if (!tx.from) {
                    return `<div class="${cls}">${prefix}备注: ${escapeHtml(tx.note || tx.to || '')}</div>`;
                }
                return `<div class="${cls}">${prefix}${shortAddr(tx.from, 8)} → ${shortAddr(tx.to, 8)}: ${tx.amount} STC${tx.fee ? '(费'+tx.fee+')':''}</div>`;
            }).join('');

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
loadWallets();
renderWallets();
renderTransfer();
refreshAll();

// 每 15 秒自动刷新一次（轻量刷新：不重绘钱包列表，只刷新动态数据）
setInterval(() => {
    refreshMempool();
    refreshChain();
    refreshAddressRank();
}, 15000);