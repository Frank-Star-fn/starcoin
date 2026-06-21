const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');
const { Blockchain, Block, Transaction, generateWallet } = require('./blockchain');

const app = express();
const PORT = process.env.PORT || 3000;
const PEER_PORT = PORT === 3000 ? 3001 : 3000;

// 初始化区块链
const starCoin = new Blockchain();

// 创建HTTP服务器
const server = http.createServer(app);

// WebSocket服务器用于节点通信
const wss = new WebSocket.Server({ server });

// 节点状态
const nodes = new Set();
const nodeConnections = new Map(); // 存储节点连接
let nodeId = `node_${PORT}_${Math.random().toString(36).substr(2, 9)}`;

// 消息类型
const MESSAGE_TYPES = {
    CHAIN: 'CHAIN',
    BLOCK: 'BLOCK',
    QUERY_LATEST: 'QUERY_LATEST',
    QUERY_ALL: 'QUERY_ALL',
    NODE_INFO: 'NODE_INFO',
    NODE_LIST: 'NODE_LIST',
    CHAIN_LENGTH: 'CHAIN_LENGTH',
    SYNC_REQUEST: 'SYNC_REQUEST'
};

// 同步状态
const syncState = {
    isSyncing: false,
    lastSyncAt: null,
    candidates: [], // 从各节点收到的候选链
    syncCount: 0,
    expectedCount: 0,
    resolved: false
};

// 节点信息
const nodeInfo = {
    id: nodeId,
    port: PORT,
    url: `ws://localhost:${PORT}`,
    httpUrl: `http://localhost:${PORT}`,
    startedAt: new Date().toISOString(),
    chainLength: starCoin.chain.length
};

// 处理WebSocket连接
wss.on('connection', (ws) => {
    console.log('📡 新节点已连接');
    
    // 存储连接信息
    const connectionId = `conn_${Math.random().toString(36).substr(2, 9)}`;
    nodeConnections.set(connectionId, { ws, id: connectionId });
    
    ws.on('message', (message) => {
        handleMessage(ws, JSON.parse(message), connectionId);
    });
    
    ws.on('close', () => {
        console.log('📡 节点已断开连接');
        nodeConnections.delete(connectionId);
    });
    
    ws.on('error', (error) => {
        console.error('❌ WebSocket错误:', error);
        nodeConnections.delete(connectionId);
    });
    
    // 发送当前链和节点信息给新节点
    sendMessage(ws, {
        type: MESSAGE_TYPES.CHAIN,
        chain: starCoin.chain
    });
    
    sendMessage(ws, {
        type: MESSAGE_TYPES.NODE_INFO,
        node: nodeInfo
    });
    
    // 请求节点列表
    sendMessage(ws, {
        type: MESSAGE_TYPES.NODE_LIST
    });
});

// 处理收到的消息
function handleMessage(ws, message, connectionId) {
    switch (message.type) {
        case MESSAGE_TYPES.QUERY_LATEST:
            sendMessage(ws, {
                type: MESSAGE_TYPES.BLOCK,
                block: starCoin.getLatestBlock()
            });
            break;
        case MESSAGE_TYPES.QUERY_ALL:
            sendMessage(ws, {
                type: MESSAGE_TYPES.CHAIN,
                chain: starCoin.chain
            });
            break;
        case MESSAGE_TYPES.CHAIN:
            handleChainResponse(message.chain, message.fromNode);
            break;
        case MESSAGE_TYPES.BLOCK:
            handleBlockResponse(message.block);
            break;
        case MESSAGE_TYPES.NODE_INFO:
            handleNodeInfo(message.node);
            break;
        case MESSAGE_TYPES.NODE_LIST:
            sendMessage(ws, {
                type: MESSAGE_TYPES.NODE_LIST,
                nodes: Array.from(nodes),
                currentNode: nodeInfo
            });
            break;
        case MESSAGE_TYPES.CHAIN_LENGTH:
            // 回复自己的链长度，供对方做快速对比
            sendMessage(ws, {
                type: MESSAGE_TYPES.CHAIN_LENGTH,
                length: starCoin.chain.length,
                latestHash: starCoin.getLatestBlock().hash,
                fromNode: nodeInfo.url
            });
            break;
        case MESSAGE_TYPES.SYNC_REQUEST:
            // 对方请求与我们同步：把我们的整条链发过去
            console.log(`🔄 收到来自 ${message.fromNode || '某节点'} 的同步请求，发送完整链`);
            sendMessage(ws, {
                type: MESSAGE_TYPES.CHAIN,
                chain: starCoin.chain,
                fromNode: nodeInfo.url
            });
            break;
    }
}

// 处理收到的完整链
// 如果处于同步状态（fromNode 附带），先汇总到 candidates，等所有节点返回后统一选最长
function handleChainResponse(chain, fromNode) {
    if (!chain || !Array.isArray(chain) || chain.length === 0) {
        console.log('📥 收到空链，忽略');
        return;
    }

    // ------ 同步汇聚模式 ------
    if (syncState.isSyncing && fromNode) {
        console.log(`📥 [同步] 收到节点 ${fromNode} 的链，长度 ${chain.length}`);
        syncState.candidates.push({
            fromNode: fromNode,
            chain: chain,
            length: chain.length,
            valid: starCoin.isChainValid(chain)
        });
        syncState.syncCount++;

        // 等所有预期节点都返回（或超时），再统一选最长
        if (syncState.syncCount >= syncState.expectedCount) {
            resolveSyncCandidates();
        }
        return;
    }

    // ------ 常规被动接收模式 ------
    const latestBlockReceived = chain[chain.length - 1];
    const latestBlockHeld = starCoin.getLatestBlock();

    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log(`📥 收到更长的链，长度: ${chain.length}，当前链长度: ${starCoin.chain.length}`);

        if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
            // 可以直接添加区块
            if (starCoin.addBlock(latestBlockReceived)) {
                broadcastLatest();
                updateNodeInfo();
            }
        } else if (chain.length === 1) {
            // 只有创世区块，不需要处理
            console.log('📥 收到创世区块');
        } else {
            // 需要替换整个链，先验证整条链是否有效
            console.log('🔄 需要替换整个链，正在验证...');
            if (!starCoin.isChainValid(chain)) {
                console.log('❌ 收到的链无效，拒绝替换');
                return;
            }
            if (starCoin.replaceChain(chain)) {
                console.log('✅ 已替换为更长的链，新长度: ' + starCoin.chain.length);
                broadcastLatest();
                updateNodeInfo();
            }
        }
    } else {
        console.log(`📥 收到的链不更长（${chain.length} vs ${starCoin.chain.length}），忽略`);
    }
}

// 处理收到的单个区块
function handleBlockResponse(block) {
    const latestBlockHeld = starCoin.getLatestBlock();

    if (block.index <= latestBlockHeld.index) {
        console.log('📥 收到的区块不新，忽略');
        return;
    }

    if (latestBlockHeld.hash === block.previousHash) {
        // 可以添加区块
        if (starCoin.addBlock(block)) {
            broadcastLatest();
            updateNodeInfo();
        }
    } else {
        // 需要查询完整链
        console.log('🔄 需要查询完整链');
        broadcastQueryAll();
    }
}

// 处理收到的节点信息
function handleNodeInfo(node) {
    if (node.url !== nodeInfo.url) {
        nodes.add(node.url);
        console.log(`📝 发现新节点: ${node.url}`);
    }
}

// 从收集到的候选链中选出"最长且有效"的那条进行替换
function resolveSyncCandidates() {
    if (syncState.resolved) return;
    syncState.resolved = true;
    syncState.isSyncing = false;

    const currentLength = starCoin.chain.length;
    const candidates = syncState.candidates;
    console.log(`🔄 [同步] 汇总完成，共 ${candidates.length} 个候选链（当前链长度: ${currentLength}）`);

    if (candidates.length === 0) {
        console.log('ℹ️  没有其他节点返回链，保持当前链');
        syncState.lastSyncAt = new Date().toISOString();
        return;
    }

    // 排除无效链
    const validCandidates = candidates.filter(c => c.valid);
    if (validCandidates.length === 0) {
        console.log('❌ [同步] 所有候选链都无效，拒绝同步');
        syncState.lastSyncAt = new Date().toISOString();
        return;
    }

    // 按长度排序，取最长的
    validCandidates.sort((a, b) => b.length - a.length);
    const best = validCandidates[0];

    console.log(`🏆 [同步] 最佳候选: 节点 ${best.fromNode}，长度 ${best.length}`);

    // 与当前链比较
    if (best.length <= currentLength) {
        console.log('ℹ️  当前链已是最长，无需替换');
        syncState.lastSyncAt = new Date().toISOString();
        return;
    }

    // 如果最长链的最后一个区块 previousHash 等于当前链末尾（说明只是分叉追加）
    const myLatest = starCoin.getLatestBlock();
    const theirLatest = best.chain[best.chain.length - 1];
    if (myLatest.hash === theirLatest.previousHash) {
        // 安全：直接追加
        console.log('🔄 [同步] 最佳链与当前链尾部连续，直接追加');
        best.chain.slice(currentLength).forEach(b => starCoin.addBlock(b));
    } else {
        // 分叉/冲突：直接替换整条链
        console.log('🔄 [同步] 发生分叉，用最长有效链替换整条链');
        if (!starCoin.replaceChain(best.chain)) {
            console.log('❌ [同步] 替换失败');
            syncState.lastSyncAt = new Date().toISOString();
            return;
        }
    }

    updateNodeInfo();
    broadcastLatest();
    syncState.lastSyncAt = new Date().toISOString();
    console.log(`✅ [同步] 完成，当前链长度: ${starCoin.chain.length}`);
}

// 主动与所有已连接节点同步
// 1. 向所有连接节点发起 SYNC_REQUEST
// 2. 收集它们返回的链（CHAIN）到 candidates
// 3. 调用 resolveSyncCandidates 选出最长有效链替换
function syncWithPeers() {
    const connectedCount = nodeConnections.size +
        (Array.from(wss.clients).filter(c => c.readyState === 1).length);

    if (connectedCount === 0) {
        console.log('⚠️  [同步] 当前没有连接的对等节点，无法同步');
        return {
            success: false,
            message: '没有可连接的对等节点',
            currentLength: starCoin.chain.length
        };
    }

    // 重置同步状态
    syncState.isSyncing = true;
    syncState.resolved = false;
    syncState.candidates = [];
    syncState.syncCount = 0;
    syncState.expectedCount = nodeConnections.size;

    console.log(`🔄 [同步] 开始与 ${syncState.expectedCount} 个节点同步...`);

    // 广播同步请求（只发给我们主动建立的出站连接，避免重复风暴）
    let sent = 0;
    nodeConnections.forEach((conn) => {
        if (conn.ws && conn.ws.readyState === 1) {
            sendMessage(conn.ws, {
                type: MESSAGE_TYPES.SYNC_REQUEST,
                fromNode: nodeInfo.url
            });
            sent++;
        }
    });

    // 广播到入站连接（由对方主动连过来的）
    wss.clients.forEach((client) => {
        if (client.readyState === 1) {
            sendMessage(client, {
                type: MESSAGE_TYPES.SYNC_REQUEST,
                fromNode: nodeInfo.url
            });
            sent++;
        }
    });

    syncState.expectedCount = sent;
    console.log(`📡 [同步] 已向 ${sent} 个节点发送同步请求`);

    if (sent === 0) {
        syncState.isSyncing = false;
        return {
            success: false,
            message: '无法向节点发送同步请求',
            currentLength: starCoin.chain.length
        };
    }

    // 设置超时兜底（10秒后无论是否收齐都解析一次）
    setTimeout(() => {
        if (!syncState.resolved) {
            console.log('⏱️  [同步] 超时，用已收到的候选进行解析');
            resolveSyncCandidates();
        }
    }, 10000);

    return {
        success: true,
        message: '同步请求已广播，正在等待节点返回...',
        requestedNodes: sent,
        currentLength: starCoin.chain.length
    };
}

// 更新节点信息
function updateNodeInfo() {
    nodeInfo.chainLength = starCoin.chain.length;
    nodeInfo.lastUpdated = new Date().toISOString();
}

// 发送消息给指定节点
function sendMessage(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

// 广播消息给所有节点（包括入站和出站连接）
function broadcast(message) {
    const jsonMessage = JSON.stringify(message);

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(jsonMessage);
        }
    });

    nodeConnections.forEach((conn) => {
        if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.send(jsonMessage);
        }
    });
}

// 广播最新区块
function broadcastLatest() {
    broadcast({
        type: MESSAGE_TYPES.BLOCK,
        block: starCoin.getLatestBlock()
    });
}

// 广播查询所有链
function broadcastQueryAll() {
    broadcast({
        type: MESSAGE_TYPES.QUERY_ALL
    });
}

// 广播节点信息
function broadcastNodeInfo() {
    broadcast({
        type: MESSAGE_TYPES.NODE_INFO,
        node: nodeInfo
    });
}

// 连接到对等节点
function connectToPeer(peerUrl) {
    if (nodes.has(peerUrl) || peerUrl === nodeInfo.url) {
        console.log('⚠️ 节点已连接或为自身节点');
        return;
    }

    const ws = new WebSocket(peerUrl);
    const connectionId = `conn_${Math.random().toString(36).substr(2, 9)}`;

    ws.on('open', () => {
        console.log(`🔗 已连接到对等节点: ${peerUrl}`);
        nodes.add(peerUrl);

        // 发送节点信息
        sendMessage(ws, {
            type: MESSAGE_TYPES.NODE_INFO,
            node: nodeInfo
        });

        // 查询最新区块
        sendMessage(ws, {
            type: MESSAGE_TYPES.QUERY_LATEST
        });

        // 存储连接
        nodeConnections.set(connectionId, { ws, id: connectionId, url: peerUrl });
    });

    ws.on('message', (message) => {
        handleMessage(ws, JSON.parse(message), connectionId);
    });

    ws.on('close', () => {
        console.log(`🔌 与对等节点的连接已关闭: ${peerUrl}`);
        nodes.delete(peerUrl);
        nodeConnections.delete(connectionId);
    });

    ws.on('error', (error) => {
        console.error(`❌ 连接对等节点出错: ${peerUrl}`, error.message || error);
        nodes.delete(peerUrl);
        nodeConnections.delete(connectionId);
    });
}

// 断开与对等节点的连接
function disconnectFromPeer(peerUrl) {
    if (!nodes.has(peerUrl)) {
        console.log(`⚠️ 节点未连接: ${peerUrl}`);
        return { success: false, message: '节点未连接' };
    }

    let found = false;

    // 查找并关闭出站连接（主动连接的节点）
    for (const [connId, conn] of nodeConnections.entries()) {
        if (conn.url === peerUrl) {
            try {
                if (conn.ws) conn.ws.close();
            } catch (error) {
                console.error('关闭连接时出错:', error.message);
            }
            nodeConnections.delete(connId);
            found = true;
            break;
        }
    }

    // 查找并关闭入站连接（其他节点连过来的）
    if (!found) {
        for (const client of wss.clients) {
            try {
                const clientUrl = client.url || `ws://${client._socket.remoteAddress}:${client._socket.remotePort}`;
                if (clientUrl.includes(peerUrl) || peerUrl.includes(clientUrl)) {
                    client.close();
                    found = true;
                    break;
                }
            } catch (error) {
                // 忽略访问 socket 信息时的错误
            }
        }
    }

    nodes.delete(peerUrl);
    updateNodeInfo();

    const message = found ? `已断开与节点 ${peerUrl} 的连接` : `已从节点列表移除 ${peerUrl}`;
    console.log(`🔌 ${message}`);
    return { success: true, message };
}

// 获取所有节点信息
async function getAllNodeInfo() {
    const nodeList = [];
    
    // 添加当前节点
    nodeList.push({
        ...nodeInfo,
        isSelf: true,
        connected: true,
        chainValid: starCoin.isChainValid()
    });
    
    // 尝试获取其他节点信息
    for (const nodeUrl of nodes) {
        try {
            const response = await fetch(`${nodeUrl.replace('ws://', 'http://')}/api/blockchain`);
            const data = await response.json();
            nodeList.push({
                id: `node_${data.port}`,
                port: data.port,
                url: nodeUrl,
                httpUrl: `http://localhost:${data.port}`,
                startedAt: new Date().toISOString(),
                chainLength: data.stats.totalBlocks,
                chainValid: data.isValid,
                connected: true,
                isSelf: false
            });
        } catch (error) {
            nodeList.push({
                id: `node_${nodeUrl.split(':')[2]}`,
                port: parseInt(nodeUrl.split(':')[2]),
                url: nodeUrl,
                httpUrl: nodeUrl.replace('ws://', 'http://'),
                startedAt: null,
                chainLength: null,
                chainValid: null,
                connected: false,
                isSelf: false,
                error: '无法连接'
            });
        }
    }
    
    return nodeList;
}

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// API路由
app.get('/api/blockchain', (req, res) => {
    res.json({
        chain: starCoin.chain,
        isValid: starCoin.isChainValid(),
        stats: {
            totalBlocks: starCoin.chain.length,
            difficulty: starCoin.difficulty,
            genesisBlock: starCoin.chain[0].hash.substring(0, 16) + '...',
            connectedNodes: nodes.size
        },
        port: PORT,
        nodeInfo: nodeInfo
    });
});

// ============================================================
// 交易相关 API
// ============================================================

// 1. 创建新钱包（生成地址和私钥）
app.post('/api/wallet/new', (req, res) => {
    const wallet = generateWallet();
    res.json({
        success: true,
        wallet: wallet
    });
});

// 2. 提交一笔转账到交易池
app.post('/api/transaction', (req, res) => {
    try {
        const { from, to, amount, fee, note, privateKey } = req.body;
        if (!from || !to || !amount) {
            return res.status(400).json({
                success: false,
                error: '必须提供 from, to, amount 字段'
            });
        }
        const tx = new Transaction(from, to, Number(amount), Number(fee) || 0, note || '');
        if (privateKey) {
            tx.signTransaction(privateKey);
        } else {
            tx.signature = 'SIGNED_BY_' + from;
        }
        const savedTx = starCoin.addTransaction(tx);
        // 广播交易到其他节点（这里简单处理，不新增消息类型，仅本地保存）
        res.json({
            success: true,
            transaction: savedTx,
            poolCount: starCoin.pendingTransactions.length
        });
    } catch (err) {
        res.status(400).json({
            success: false,
            error: err.message
        });
    }
});

// 3. 查询地址余额
app.get('/api/balance/:address', (req, res) => {
    const address = req.params.address;
    const balance = starCoin.getBalance(address);
    const pendingInPool = starCoin.pendingTransactions
        .filter(tx => tx.from === address || tx.to === address)
        .length;
    res.json({
        success: true,
        address: address,
        balance: balance,
        pendingTransactions: pendingInPool,
        historyCount: starCoin.getTransactionHistory(address).length
    });
});

// 4. 查询地址交易历史
app.get('/api/transactions/:address', (req, res) => {
    const history = starCoin.getTransactionHistory(req.params.address);
    res.json({
        success: true,
        address: req.params.address,
        total: history.length,
        transactions: history
    });
});

// 5. 查看交易池 (Mempool)
app.get('/api/mempool', (req, res) => {
    res.json({
        success: true,
        count: starCoin.pendingTransactions.length,
        transactions: starCoin.pendingTransactions
    });
});

// 6. 清空交易池
app.delete('/api/mempool', (req, res) => {
    const count = starCoin.pendingTransactions.length;
    starCoin.pendingTransactions = [];
    res.json({
        success: true,
        message: `已清空 ${count} 笔待打包交易`,
        cleared: count
    });
});

// 7. 所有地址排行榜
app.get('/api/addresses', (req, res) => {
    const addresses = starCoin.getAllAddresses();
    res.json({
        success: true,
        total: addresses.length,
        addresses: addresses
    });
});

// 8. 挖矿（从交易池打包交易）
app.post('/api/mine', (req, res) => {
    const { minerAddress, data } = req.body;
    const startTime = Date.now();
    try {
        const newBlock = starCoin.mineBlock(minerAddress || starCoin.miningAddress, data);
        const miningTime = Date.now() - startTime;

        // 广播新区块到其他节点
        broadcastLatest();
        updateNodeInfo();

        res.json({
            success: true,
            block: newBlock,
            transactionCount: newBlock.transactions.length,
            reward: starCoin.miningReward,
            miningTime: miningTime + 'ms'
        });
    } catch (err) {
        res.status(400).json({
            success: false,
            error: err.message
        });
    }
});

app.get('/api/validate', (req, res) => {
    res.json({
        success: true,
        isValid: starCoin.isChainValid(),
        totalBlocks: starCoin.chain.length
    });
});

// ============ 节点同步 API ============

// 主动与所有已连接节点同步，选用最长有效链
app.post('/api/sync', (req, res) => {
    const result = syncWithPeers();
    res.json({
        ...result,
        valid: starCoin.isChainValid(),
        syncState: {
            isSyncing: syncState.isSyncing,
            lastSyncAt: syncState.lastSyncAt,
            candidateCount: syncState.candidates.length
        }
    });
});

// 查询同步状态
app.get('/api/sync/status', (req, res) => {
    // 收集每个连接节点的链长度信息
    const peerSummary = syncState.candidates.map(c => ({
        node: c.fromNode,
        length: c.length,
        valid: c.valid
    }));

    res.json({
        success: true,
        isSyncing: syncState.isSyncing,
        lastSyncAt: syncState.lastSyncAt,
        selfChain: {
            length: starCoin.chain.length,
            latestHash: starCoin.getLatestBlock().hash,
            valid: starCoin.isChainValid()
        },
        connectedNodes: nodes.size,
        peerChains: peerSummary,
        candidates: syncState.candidates.length
    });
});

// ============ 数据持久化 API ============

// 获取数据持久化状态
app.get('/api/storage/status', (req, res) => {
    try {
        const fs = require('fs');
        const filePath = starCoin.dataFile;
        const exists = fs.existsSync(filePath);
        let fileSize = 0;
        let lastModified = null;
        if (exists) {
            const stats = fs.statSync(filePath);
            fileSize = stats.size;
            lastModified = stats.mtime.toISOString();
        }
        res.json({
            enabled: true,
            file: filePath,
            exists: exists,
            size: fileSize,
            sizeKB: (fileSize / 1024).toFixed(2),
            lastModified: lastModified,
            totalBlocks: starCoin.chain.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 手动保存
app.post('/api/storage/save', (req, res) => {
    const success = starCoin.saveToFile();
    res.json({
        success: success,
        message: success ? '✅ 区块链已保存到本地文件' : '❌ 保存失败',
        totalBlocks: starCoin.chain.length,
        file: starCoin.dataFile
    });
});

// 重新从文件加载
app.post('/api/storage/reload', (req, res) => {
    const success = starCoin.loadFromFile();
    res.json({
        success: success,
        message: success ? '✅ 已从本地文件重新加载区块链' : '⚠️  无法从文件加载（已重建创世区块）',
        totalBlocks: starCoin.chain.length
    });
});

// 清除本地数据并重置
app.post('/api/storage/reset', (req, res) => {
    const success = starCoin.clearDataFile();
    broadcastLatest();
    res.json({
        success: success,
        message: success ? '🔄 已重置区块链为创世区块状态' : '❌ 重置失败',
        totalBlocks: starCoin.chain.length
    });
});

// 导出区块链为 JSON 文件（下载）
app.get('/api/storage/export', (req, res) => {
    try {
        const data = {
            chain: starCoin.chain,
            exportedAt: new Date().toISOString(),
            port: PORT,
            version: '1.0'
        };
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="starcoin_chain_${PORT}_${Date.now()}.json"`);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 从上传的 JSON 导入区块链
app.post('/api/storage/import', (req, res) => {
    try {
        const { chain } = req.body;
        if (!chain || !Array.isArray(chain) || chain.length === 0) {
            return res.status(400).json({ error: '无效的区块链数据' });
        }
        if (!starCoin.isChainValid(chain)) {
            return res.status(400).json({ error: '导入的区块链验证失败' });
        }
        starCoin.chain = chain.map(b => {
            const txSrc = b.transactions || (b.data ? b.data : []);
            const block = new Block(b.index, b.timestamp, txSrc, b.previousHash);
            block.nonce = b.nonce;
            block.hash = b.hash;
            return block;
        });
        starCoin.saveToFile();
        broadcastLatest();
        res.json({
            success: true,
            message: `✅ 已导入 ${chain.length} 个区块`,
            totalBlocks: starCoin.chain.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/connect', (req, res) => {
    const { peerUrl } = req.body;
    if (!peerUrl) {
        return res.status(400).json({ error: '节点URL不能为空' });
    }

    connectToPeer(peerUrl);
    res.json({
        success: true,
        message: `正在连接到节点: ${peerUrl}`
    });
});

app.post('/api/disconnect', (req, res) => {
    const { peerUrl } = req.body;
    if (!peerUrl) {
        return res.status(400).json({ error: '节点URL不能为空' });
    }

    const result = disconnectFromPeer(peerUrl);
    res.json({
        success: result.success,
        message: result.message
    });
});

app.get('/api/nodes', (req, res) => {
    res.json({
        nodes: Array.from(nodes),
        count: nodes.size,
        currentNode: nodeInfo
    });
});

app.get('/api/all-nodes', async (req, res) => {
    const allNodes = await getAllNodeInfo();
    res.json({
        nodes: allNodes,
        total: allNodes.length
    });
});

// 主页路由
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 启动服务器
server.listen(PORT, () => {
    console.log(`🚀 StarCoin 服务器运行在 http://localhost:${PORT}`);
    console.log(`📊 初始区块链已创建，包含 ${starCoin.chain.length} 个区块`);
    console.log(`🆔 节点ID: ${nodeId}`);

    // 自动连接到对等节点（如果是第二个节点）
    if (PORT !== 3000) {
        setTimeout(() => {
            connectToPeer(`ws://localhost:3000`);
            // 连接后 3 秒发起一次初始同步
            setTimeout(() => {
                console.log('🔄 启动后首次同步...');
                syncWithPeers();
            }, 3000);
        }, 1000);
    } else {
        // 主节点也尝试在 5 秒后向已连入的节点进行一次同步
        setTimeout(() => {
            if (nodeConnections.size > 0) {
                console.log('🔄 主节点启动后同步检查...');
                syncWithPeers();
            }
        }, 5000);
    }

    // 每 60 秒自动同步一次（防止因网络抖动导致不同步）
    setInterval(() => {
        if (nodeConnections.size > 0) {
            console.log('⏰ 定期自动同步...');
            syncWithPeers();
        }
    }, 60000);
});

// 导出用于测试
module.exports = { starCoin, Blockchain, Block, Transaction, generateWallet };