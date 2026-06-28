// ============================================================
// routes/api-tx.js — 钱包 + 交易 + 余额 + 交易池路由
// ============================================================
const express = require('express');
const { Transaction, generateWallet, importWalletFromPem } = require('../blockchain/blockchain');
const { AppError, wrapAsync } = require('./error-handler');

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
    router.post('/wallet/new', wrapAsync(async (req, res) => {
        const wallet = generateWallet();
        if (!wallet || !wallet.address) {
            throw new AppError(500, '钱包生成失败，请重试', 'WALLET_GEN_FAILED');
        }
        res.json({
            success: true,
            wallet: wallet
        });
    }));

    // ============================================================
    // 1b. 从 PEM 私钥导入钱包（恢复地址和公钥）
    // ============================================================
    router.post('/wallet/import', wrapAsync(async (req, res) => {
        const { privateKeyPem } = req.body;
        if (!privateKeyPem) {
            throw new AppError(400, '必须提供 privateKeyPem 字段（PEM 格式私钥）', 'MISSING_PARAM');
        }
        let wallet;
        try {
            wallet = importWalletFromPem(privateKeyPem);
        } catch (err) {
            throw new AppError(400, '私钥导入失败: ' + err.message, 'INVALID_PEM');
        }
        res.json({
            success: true,
            message: '✅ 私钥有效，已恢复钱包',
            wallet: wallet
        });
    }));

    // ============================================================
    // 1c. 验证 PEM 私钥是否有效（仅验证，不返回完整私钥）
    // ============================================================
    router.post('/wallet/verify-pem', wrapAsync(async (req, res) => {
        const { privateKeyPem } = req.body;
        if (!privateKeyPem) {
            throw new AppError(400, '必须提供 privateKeyPem 字段', 'MISSING_PARAM');
        }
        let wallet;
        try {
            wallet = importWalletFromPem(privateKeyPem);
        } catch (err) {
            throw new AppError(400, 'PEM 验证失败: ' + err.message, 'INVALID_PEM');
        }
        res.json({
            success: true,
            message: '✅ PEM 格式有效',
            publicKey: wallet.publicKey,
            address: wallet.address
        });
    }));

    // ============================================================
    // 2. 提交一笔转账到交易池（需要 ECDSA 签名）
    // ============================================================
    router.post('/transaction', wrapAsync(async (req, res) => {
        const { from, to, amount, fee, note, privateKey, publicKey } = req.body;

        if (!from || !to || !amount) {
            throw new AppError(400, '必须提供 from, to, amount 字段', 'MISSING_PARAM');
        }
        if (!privateKey || !publicKey) {
            throw new AppError(400, '必须提供 privateKey 和 publicKey 用于 ECDSA 签名。请先用 POST /api/wallet/new 生成钱包。', 'MISSING_CREDENTIALS');
        }

        const tx = new Transaction(from, to, Number(amount), Number(fee) || 0, note || '');
        tx.signTransaction(privateKey, publicKey);
        let savedTx;
        try {
            savedTx = starCoin.addTransaction(tx);
        } catch (err) {
            throw new AppError(400, err.message, 'TX_REJECTED');
        }

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
    }));

    // ============================================================
    // 3. 查询地址余额
    // ============================================================
    router.get('/balance/:address', wrapAsync(async (req, res) => {
        const address = req.params.address;
        if (!address || address.length < 2) {
            throw new AppError(400, '无效的地址格式', 'INVALID_ADDRESS');
        }
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
    }));

    // ============================================================
    // 4. 查询地址交易历史
    // ============================================================
    router.get('/transactions/:address', wrapAsync(async (req, res) => {
        const address = req.params.address;
        if (!address || address.length < 2) {
            throw new AppError(400, '无效的地址格式', 'INVALID_ADDRESS');
        }
        const history = starCoin.getTransactionHistory(address);
        res.json({
            success: true,
            address: address,
            total: history.length,
            transactions: history
        });
    }));

    // ============================================================
    // 5. 查看交易池 (Mempool)
    // ============================================================
    router.get('/mempool', (req, res) => {
        res.json({
            success: true,
            count: starCoin.pendingTransactions.length,
            transactions: starCoin.pendingTransactions
        });
    });

    // ============================================================
    // 6. 清空交易池
    // ============================================================
    router.delete('/mempool', (req, res) => {
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
    router.get('/addresses', (req, res) => {
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