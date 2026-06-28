const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const config = require('./config');
const { Blockchain, Block, Transaction, generateWallet, importWalletFromPem } = require('./blockchain/blockchain');
const { createP2P } = require('./p2p/p2p');
const createRoutes = require('./routes');
const {
    createNotFoundMiddleware,
    createErrorMiddleware
} = require('./routes/error-handler');

const app = express();
const PORT = config.PORT;

// 初始化区块链
const starCoin = new Blockchain();

// 创建 HTTP 服务器
const server = http.createServer(app);

// ============================================================
// 前端 WebSocket 推送服务（与 P2P 共享同一 WebSocket 服务器）
// 通过 URL 路径区分: 前端连接 /ws, P2P 节点连接 /
// ============================================================
const frontendClients = new Set();

/**
 * 向所有已连接的前端客户端广播消息
 * @param {string} type - 消息类型: 'newBlock' | 'newTransaction' | 'chainUpdated'
 * @param {object} data - 附加数据
 */
function broadcastToFrontend(type, data = {}) {
    const message = JSON.stringify({ type, ...data, timestamp: Date.now() });
    frontendClients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        } else {
            frontendClients.delete(client);
        }
    });
}

// 初始化 P2P 网络层（传入 frontendConnection 回调，由 P2P 层代为处理前端 WS 连接）
const p2p = createP2P(server, starCoin, PORT, {
    onFrontendConnection: (ws) => {
        frontendClients.add(ws);
        console.log(`🎯 前端客户端已连接，当前连接数: ${frontendClients.size}`);

        ws.on('close', () => {
            frontendClients.delete(ws);
            console.log(`🔌 前端客户端已断开，剩余连接数: ${frontendClients.size}`);
        });

        ws.on('error', (err) => {
            frontendClients.delete(ws);
            console.error('❌ 前端 WebSocket 错误:', err.message);
        });
    },
    onChainChange: () => {
        broadcastToFrontend('chainUpdated');
    }
});

// 静态文件服务
app.use(express.static(path.join(__dirname, '..', 'public')));
// 同时提供 src/ 目录下的 JS 文件的访问
app.use('/src', express.static(path.join(__dirname, '..', 'src')));
app.use(express.json());

// ============================================================
// API 路由 — 委托给 routes/ 目录下的子模块处理
// ============================================================
app.use('/api', createRoutes(starCoin, p2p, broadcastToFrontend, PORT));

// 主页路由
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ============================================================
// 应用级错误处理
// ============================================================
// 404 兜底（捕获未匹配的任意请求路径）
app.use(createNotFoundMiddleware());
// 统一错误响应
app.use(createErrorMiddleware());

// 启动服务器
server.listen(PORT, () => {
    console.log(`🚀 StarCoin 服务器运行在 http://localhost:${PORT}`);
    console.log(`📊 初始区块链已创建，包含 ${starCoin.chain.length} 个区块`);
    console.log(`🆔 节点ID: ${p2p.nodeInfo.id}`);

    // ---------- 种子节点发现与启动同步 ----------
    // 从配置 SEED_PEERS 获取种子节点列表（逗号分隔），
    // 例如: SEED_PEERS="ws://localhost:3000,ws://localhost:3001"
    const seedPeers = [...config.SEED_PEERS];

    // 如果是全新启动（无本地数据），优先从其他节点获取链
    if (starCoin.freshStart) {
        console.log('🆕 检测到全新节点（无本地数据），将优先从其他节点同步区块链...');
        if (seedPeers.length === 0) {
            // 未配置 SEED_PEERS 时，默认尝试连接其他常见端口
            const commonPorts = ['3000', '3001', '3002', '3003', '3004'];
            for (const p of commonPorts) {
                if (p !== String(PORT)) {
                    seedPeers.push(`ws://localhost:${p}`);
                }
            }
        }
    } else {
        // 有本地数据，但仍尝试连接已配置的种子节点
        if (seedPeers.length === 0) {
            // 如果本地有数据且非 3000 端口，默认尝试连接 3000 同步
            if (PORT !== 3000) {
                seedPeers.push('ws://localhost:3000');
            }
        }
    }

    // 连接种子节点并执行首次同步
    if (seedPeers.length > 0) {
        console.log(`🔗 将尝试连接 ${seedPeers.length} 个种子节点: ${seedPeers.join(', ')}`);
        setTimeout(() => {
            let connected = 0;
            for (const peerUrl of seedPeers) {
                try {
                    p2p.connectToPeer(peerUrl);
                    connected++;
                } catch (e) {
                    // 连接失败静默处理
                }
            }
            // 等待连接建立后同步
            const syncDelay = starCoin.freshStart ? 5000 : 3000;
            setTimeout(() => {
                console.log('🔄 启动后首次同步...');
                const result = p2p.syncWithPeers();
                if (starCoin.freshStart) {
                    // 同步完成后检查是否获取到了数据
                    setTimeout(() => {
                        if (starCoin.chain.length <= 1) {
                            console.log('ℹ️  未从其他节点获取到区块链数据，将使用本地创世区块开始新链');
                        } else {
                            console.log(`✅ 已从其他节点同步区块链，当前链长度: ${starCoin.chain.length}`);
                        }
                    }, config.SYNC_TIMEOUT + 2000); // 等待同步超时 + 缓冲
                }
            }, syncDelay);
        }, config.SYNC_STARTUP_CONNECT_DELAY);
    } else {
        // 没有种子节点，仅对非 3000 节点保持向后兼容
        if (PORT !== 3000) {
            setTimeout(() => {
                p2p.connectToPeer('ws://localhost:3000');
                setTimeout(() => {
                    console.log('🔄 启动后首次同步...');
                    p2p.syncWithPeers();
                }, 3000);
            }, 1000);
        }
    }

    // 定期自动同步
    setInterval(() => {
        if (p2p.getConnectedCount() > 0) {
            console.log('⏰ 定期自动同步...');
            p2p.syncWithPeers();
        }
    }, config.SYNC_INTERVAL);
});

// 导出用于测试
module.exports = { starCoin, Blockchain, Block, Transaction, generateWallet, importWalletFromPem };