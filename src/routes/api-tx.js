// ============================================================
// routes/api-tx.js — 钱包 + 交易 + 余额 + 交易池路由
// ============================================================
const express = require('express');
const { Transaction, generateWallet, importWalletFromPem } = require('../blockchain');

/**
 * 创建钱包与交易相关的路由
 * @param {object} starCoin               - Blockchain 实例
 * @param {function} broadcastToFrontend  - WebSocket 广播函数
 * @param {object} p2p                    - P2P 网络层实例
 * @returns {express.Router}
 */
function createTxRoutes(starCoin, broadcastToFrontend, p2p) {
    const router = express.Router();

    // ============================================================
    // 1. 创建新钱包（生成地址和私钥）
    // ============================================================
    router.post('/api/wallet/new', (req, res) => {
        const wallet = generateWallet();
        res.json({
            success: true,
            wallet: wallet
        });
    });

    // ============================================================
    // 1b. 从 PEM 私钥导入钱包（恢复地址和公钥）
    // ============================================================
    router.post('/api/wallet/import', (req, res) => {
        try {
            const { privateKeyPem } = req.body;
            if (!privateKeyPem) {
                return res.status(400).json({
                    success: false,
                    error: '必须提供 privateKeyPem 字段（PEM 格式私钥）'
                });
            }
            const wallet = importWalletFromPem(privateKeyPem);
            res.json({
                success: true,
                message: '✅ 私钥有效，已恢复钱包',
                wallet: wallet
            });
        } catch (err) {
            res.status(400).json({
                success: false,
                error: '私钥导入失败: ' + err.message
            });
        }
    });

    // ============================================================
    // 1c. 验证 PEM 私钥是否有效（仅验证，不返回完整私钥）
    // ============================================================
    router.post('/api/wallet/verify-pem', (req, res) => {
        try {
            const { privateKeyPem } = req.body;
            if (!privateKeyPem) {
                return res.status(400).json({
                    success: false,
                    error: '必须提供 privateKeyPem 字段'
                });
            }
            const wallet = importWalletFromPem(privateKeyPem);
            res.json({
                success: true,
                message: '✅ PEM 格式有效',
                publicKey: wallet.publicKey,
                address: wallet.address
            });
        } catch (err) {
            res.status(400).json({
                success: false,
                error: 'PEM 验证失败: ' + err.message
            });
        }
    });

    // ============================================================
    // 2. 提交一笔转账到交易池（需要 ECDSA 签名）
    // ============================================================
    router.post('/api/transaction', (req, res) => {
        try {
            const { from, to, amount, fee, note, privateKey, publicKey } = req.body;
            if (!from || !to || !amount) {
                return res.status(400).json({
                    success: false,
                    error: '必须提供 from, to, amount 字段'
                });
            }
            if (!privateKey || !publicKey) {
                return res.status(400).json({
                    success: false,
                    error: '必须提供 privateKey 和 publicKey 用于 ECDSA 签名。请先用 POST /api/wallet/new 生成钱包。'
                });
            }
            const tx = new Transaction(from, to, Number(amount), Number(fee) || 0, note || '');
            tx.signTransaction(privateKey, publicKey);
            const savedTx = starCoin.addTransaction(tx);
            // WebSocket 推送：新交易到达
            broadcastToFrontend('newTransaction', {
                poolCount: starCoin.pendingTransactions.length,
                txId: savedTx.id
            });
            // P2P 广播：将交易广播到其他节点
            p2p.broadcastTransaction(savedTx);
            res.json({
                success: true,
                message: '交易已通过 ECDSA 签名验证，已加入交易池',
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

    // ============================================================
    // 3. 查询地址余额
    // ============================================================
    router.get('/api/balance/:address', (req, res) => {
        const address = req.params.address;
        const balance = starCoin.getBalance(address);
        const totalBalance = starCoin.getBalance(address, true);
        const lockedRewards = starCoin.getLockedRewards(address);
        const pendingInPool = starCoin.pendingTransactions
            .filter(tx => tx.from === address || tx.to === address)
            .length;
        res.json({
            success: true,
            address: address,
            balance: balance,
            totalBalance: totalBalance,
            lockedRewards: lockedRewards,
            coinbaseMaturity: starCoin.coinbaseMaturity,
            pendingTransactions: pendingInPool,
            historyCount: starCoin.getTransactionHistory(address).length
        });
    });

    // ============================================================
    // 4. 查询地址交易历史
    // ============================================================
    router.get('/api/transactions/:address', (req, res) => {
        const history = starCoin.getTransactionHistory(req.params.address);
        res.json({
            success: true,
            address: req.params.address,
            total: history.length,
            transactions: history
        });
    });

    // ============================================================
    // 5. 查看交易池 (Mempool)
    // ============================================================
    router.get('/api/mempool', (req, res) => {
        res.json({
            success: true,
            count: starCoin.pendingTransactions.length,
            transactions: starCoin.pendingTransactions
        });
    });

    // ============================================================
    // 6. 清空交易池
    // ============================================================
    router.delete('/api/mempool', (req, res) => {
        const count = starCoin.pendingTransactions.length;
        starCoin.pendingTransactions = [];
        res.json({
            success: true,
            message: `已清空 ${count} 笔待打包交易`,
            cleared: count
        });
    });

    // ============================================================
    // 7. 所有地址排行榜
    // ============================================================
    router.get('/api/addresses', (req, res) => {
        const addresses = starCoin.getAllAddresses();
        res.json({
            success: true,
            total: addresses.length,
            addresses: addresses
        });
    });

    return router;
}

module.exports = createTxRoutes;