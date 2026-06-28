/* ============================================================
   挖矿引擎
   职责：单次挖矿 + 自动持续挖矿（SSE 流）
   依赖：app.js (showMessage, api) + main.js (refreshAll)
   ============================================================ */

// ============================================================
// 单次挖矿（SSE 流，用于前端动画）
// ============================================================
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

    // 如果自动挖矿正在运行，先停止它，防止两个挖矿模式冲突
    if (autoMineState.active) {
        await toggleAutoMine();
    }

    // 重置取消标志（每次新开单次挖矿时清除之前的取消状态）
    singleMineCancelled = false;

    btn.disabled = true;
    btn.textContent = '⛏️ 挖矿中...';

    // 显示并重置动画状态（先清空再激活，防止 CSS 突变抖动）
    animContainer.style.display = 'block';
    animContainer.className = 'mining-animation';
    void animContainer.offsetWidth;
    animContainer.className = 'mining-animation mining-active';
    nonceDisplay.textContent = '0';
    hashDisplay.textContent = '计算中...';
    progressBar.style.width = '0%';
    statusText.textContent = '⛏️ 正在寻找满足条件的 nonce...';
    const hashrateElInit = document.getElementById('miningHashrate');
    if (hashrateElInit) hashrateElInit.textContent = '--';
    showMessage('txMessage', '', 'info', 0);

    // 最佳进度（单调递增，防止进度条抖动）
    let bestPct = 0;

    // 用于统计
    let lastNonce = 0;
    let startTime = Date.now();

    // 使用 EventSource (SSE) 接收挖矿进度
    const url = `/api/mine/stream?minerAddress=${encodeURIComponent(minerAddr)}`;
    const eventSource = new EventSource(url);
    let miningCompleted = false;
    // 保存引用到全局变量，以便自动挖矿启动时能关闭此连接
    singleMineEventSource = eventSource;

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

                // 清理全局引用
                singleMineEventSource = null;

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

                // 主动刷新期间，短暂忽略 WebSocket 推送，避免重复 API 调用
                if (typeof setIgnoreWs === 'function') setIgnoreWs(3000);
                refreshAll();
                return;
            }

            if (data.error) {
                miningCompleted = true;
                eventSource.close();
                singleMineEventSource = null;
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
                    // 只升不降：仅当当前进度超过历史最佳时才更新进度条
                    if (pct > bestPct) {
                        bestPct = pct;
                        progressBar.style.width = pct + '%';
                    }
                }

                // 计算哈希速率
                const elapsed = (Date.now() - startTime) / 1000;
                if (elapsed > 0) {
                    const rate = Math.round(Number(data.nonce) / elapsed);
                    statusText.textContent = `⛏️ 已尝试: ${Number(data.nonce).toLocaleString()} 次`;
                    const hashrateEl = document.getElementById('miningHashrate');
                    if (hashrateEl) hashrateEl.textContent = rate.toLocaleString();
                }
            }
        } catch (err) {
            console.error('挖矿 SSE 消息处理出错:', err);
            singleMineEventSource = null;
            // 如果是被主动取消的，不恢复按钮（由自动挖矿控制）、不显示错误
            if (!singleMineCancelled) {
                enableMineButton();
            }
        }
    };

    eventSource.onerror = () => {
        singleMineEventSource = null;
        if (!miningCompleted) {
            // 如果单次挖矿是被自动挖矿主动取消的，则静默关闭，不显示错误信息
            if (singleMineCancelled) {
                eventSource.close();
                singleMineCancelled = false;
                return;
            }
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
    timeoutId: null,          // 下次挖矿的延时句柄
    eventSource: null         // 当前 SSE 连接（停止时可立即关闭）
};

// 跟踪单次挖矿的 SSE 连接，用于在启动自动挖矿时关闭它，防止两个 SSE 同时更新同一批 DOM 导致文字抖动
let singleMineEventSource = null;
// 标记单次挖矿是否被自动挖矿主动取消，用于阻止 onerror 误报错误信息
let singleMineCancelled = false;

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
        // 立即关闭正在运行的 SSE 连接，终止当前挖矿动画
        if (autoMineState.eventSource) {
            autoMineState.eventSource.close();
            autoMineState.eventSource = null;
        }
        // 立即隐藏挖矿动画
        if (animContainer) {
            animContainer.style.display = 'none';
        }
        btn.className = 'secondary';
        btn.textContent = '⏱️ 自动持续挖矿';
        statusEl.style.display = 'none';

        // 恢复普通挖矿按钮
        enableMineButton();

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

    // 关闭任何正在进行的单次挖矿 SSE，防止两个 SSE 同时更新同一批 DOM 导致文字抖动
    if (singleMineEventSource) {
        singleMineCancelled = true;         // 标记单次挖矿是被主动取消的，阻止 onerror 显示错误
        singleMineEventSource.close();
        singleMineEventSource = null;
    }

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
    // 先重置到中性状态再激活，防止从 mining-success 切换时 CSS 动画突变导致抖动
    animContainer.className = 'mining-animation';
    void animContainer.offsetWidth;
    animContainer.className = 'mining-animation mining-active';
    nonceDisplay.textContent = '0';
    hashDisplay.textContent = '计算中...';
    progressBar.style.width = '0%';
    statusText.textContent = '⛏️ 自动挖矿中...';
    const hashrateElInit = document.getElementById('miningHashrate');
    if (hashrateElInit) hashrateElInit.textContent = '--';

    // 最佳进度（单调递增，防止进度条抖动）
    let bestPct = 0;

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
    // 保存 SSE 引用，方便停止时立即关闭
    autoMineState.eventSource = eventSource;
    let miningCompleted = false;

    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            // 如果已被停止，忽略后续所有事件并关闭连接
            if (!autoMineState.active && !data.found) {
                eventSource.close();
                if (autoMineState.eventSource === eventSource) {
                    autoMineState.eventSource = null;
                }
                return;
            }

            if (data.started) {
                statusText.textContent = data.message || '⛏️ 自动挖矿中...';
                if (data.difficulty != null) difficultyDisplay.textContent = data.difficulty;
                return;
            }

            if (data.found) {
                miningCompleted = true;
                eventSource.close();
                if (autoMineState.eventSource === eventSource) {
                    autoMineState.eventSource = null;
                }

                // 更新显示
                if (data.nonce != null) nonceDisplay.textContent = Number(data.nonce).toLocaleString();
                if (data.difficulty != null) difficultyDisplay.textContent = data.difficulty;
                if (data.hash) hashDisplay.textContent = data.hash;
                progressBar.style.width = '100%';
                animContainer.className = 'mining-animation mining-success';
                statusText.textContent = data.message || '🎉 挖矿成功！';

                // 刷新数据（主动刷新期间，短暂忽略 WebSocket 推送，避免重复 API 调用）
                if (typeof setIgnoreWs === 'function') setIgnoreWs(3000);
                refreshAll();

                // 计数 + 重置连续失败计数（成功说明链路恢复正常）
                autoMineState.blocksMined++;
                autoMineState.consecutiveFailures = 0;

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
                if (autoMineState.eventSource === eventSource) {
                    autoMineState.eventSource = null;
                }
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
                    // 只升不降：仅当当前进度超过历史最佳时才更新进度条
                    if (pct > bestPct) {
                        bestPct = pct;
                        progressBar.style.width = pct + '%';
                    }
                }

                const elapsed = (Date.now() - startTime) / 1000;
                if (elapsed > 0) {
                    const rate = Math.round(Number(data.nonce) / elapsed);
                    statusText.textContent = `⏱️ 自动挖矿 | 已尝试: ${Number(data.nonce).toLocaleString()} 次`;
                    const hashrateEl = document.getElementById('miningHashrate');
                    if (hashrateEl) hashrateEl.textContent = rate.toLocaleString();
                }
            }
        } catch (err) {
            console.error('自动挖矿 SSE 处理出错:', err);
            if (!miningCompleted) {
                eventSource.close();
                if (autoMineState.eventSource === eventSource) {
                    autoMineState.eventSource = null;
                }
                stopAutoMineOnError(err.message);
            }
        }
    };

    eventSource.onerror = () => {
        if (autoMineState.eventSource === eventSource) {
            autoMineState.eventSource = null;
        }
        if (!miningCompleted && autoMineState.active) {
            eventSource.close();
            // EventSource 在网络异常/限流（429）时都会触发 onerror，
            // 此时不直接永久停止，而是退避重试。累计失败过多才停止。
            autoMineState.consecutiveFailures = (autoMineState.consecutiveFailures || 0) + 1;
            const maxFailures = 5;
            if (autoMineState.consecutiveFailures >= maxFailures) {
                stopAutoMineOnError('连续失败，已停止');
                return;
            }
            const delay = Math.min(500 * Math.pow(2, autoMineState.consecutiveFailures - 1), 5000);
            statusText.textContent = `⚠️ 连接中断，${Math.round(delay / 1000)}s 后重试（${autoMineState.consecutiveFailures}/${maxFailures}）`;
            animContainer.className = 'mining-animation mining-error';
            autoMineState.timeoutId = setTimeout(() => {
                if (autoMineState.active) startNextAutoMine();
            }, delay);
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