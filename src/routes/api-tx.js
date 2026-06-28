// ============================================================
// routes/api-tx.js — 钱包 + 交易 + 余额 + 交易池路由
// ============================================================
const express = require('express');
const { Transaction, generateWallet, importWalletFromPem,
        generateMnemonic, validateMnemonic, mnemonicToWallet, normalizeCurrency } = require('../blockchain/blockchain');
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
    // 1d. 生成新钱包并返回 BIP39 助记词
    // ============================================================
    router.post('/wallet/new-with-mnemonic', wrapAsync(async (req, res) => {
        const strength = req.body.strength || 128;
        const mnemonic = generateMnemonic(strength);
        const wallet = mnemonicToWallet(mnemonic);
        if (!wallet || !wallet.address) {
            throw new AppError(500, '钱包生成失败，请重试', 'WALLET_GEN_FAILED');
        }
        res.json({
            success: true,
            mnemonic: wallet.mnemonic,
            wallet: {
                privateKey: wallet.privateKey,
                publicKey: wallet.publicKey,
                address: wallet.address
            }
        });
    }));

    // ============================================================
    // 1e. 从 BIP39 助记词导入钱包
    // ============================================================
    router.post('/wallet/import-mnemonic', wrapAsync(async (req, res) => {
        const { mnemonic, passphrase } = req.body;
        if (!mnemonic || typeof mnemonic !== 'string' || !mnemonic.trim()) {
            throw new AppError(400, '必须提供 mnemonic 字段（助记词短语）', 'MISSING_PARAM');
        }
        // 规范化：合并空格、转小写（bip39 词库全小写）
        const cleaned = mnemonic.trim().replace(/\s+/g, ' ').toLowerCase();
        if (!validateMnemonic(cleaned)) {
            throw new AppError(400, '助记词无效：校验和验证失败，请检查单词拼写', 'INVALID_MNEMONIC');
        }
        let wallet;
        try {
            wallet = mnemonicToWallet(cleaned, passphrase || '');
        } catch (err) {
            throw new AppError(400, '助记词导入失败: ' + err.message, 'MNEMONIC_IMPORT_FAILED');
        }
        res.json({
            success: true,
            message: '✅ 助记词验证有效，已恢复钱包',
            wallet: {
                privateKey: wallet.privateKey,
                publicKey: wallet.publicKey,
                address: wallet.address
            }
        });
    }));

    // ============================================================
    // [已注释] 1f. 获取 cBTC/cETH 测试代币（空投到指定地址）
    // 前端入口已移除，如需恢复请取消注释
    // ============================================================
    // router.post('/token/airdrop', wrapAsync(async (req, res) => {
    //     const { address, currency, amount } = req.body;
    //     if (!address) {
    //         throw new AppError(400, '必须提供 address 字段（接收方地址）', 'MISSING_PARAM');
    //     }
    //     const rawCur = currency || 'cBTC';
    //     const cur = normalizeCurrency(rawCur);
    //     if (!cur || cur === 'STC') {
    //         throw new AppError(400, 'currency 仅支持 cBTC 或 cETH', 'INVALID_CURRENCY');
    //     }
    //     const amt = parseFloat(amount) || 0.01;
    //     if (amt <= 0) throw new AppError(400, 'amount 必须大于 0', 'INVALID_AMOUNT');

    //     // 构造 SYSTEM 交易（无需签名）
    //     const airdropTx = new Transaction('SYSTEM', address, amt, 0, `${cur} Airdrop`, cur);
    //     // 直接加入 pendingTransactions
    //     starCoin.pendingTransactions.push(airdropTx);

    //     // P2P 广播（让其他节点也收到这笔空投）
    //     if (p2p && p2p.broadcastTransaction) p2p.broadcastTransaction(airdropTx);

    //     broadcastToFrontend('newTransaction', {
    //         poolCount: starCoin.pendingTransactions.length,
    //         txId: airdropTx.id
    //     });

    //     res.json({
    //         success: true,
    //         message: `🎉 已向 ${address.substring(0, 16)}... 发放 ${amt} ${cur}（已加入交易池，下次挖矿时打包）`,
    //         transaction: airdropTx,
    //         poolCount: starCoin.pendingTransactions.length
    //     });
    // }));

    // ============================================================
    // 2. 提交一笔转账到交易池（支持多币种：currency = STC | cBTC | cETH）
    // ============================================================
    router.post('/transaction', wrapAsync(async (req, res) => {
        const { from, to, amount, fee, note, privateKey, publicKey, currency } = req.body;

        if (!from || !to || !amount) {
            throw new AppError(400, '必须提供 from, to, amount 字段', 'MISSING_PARAM');
        }
        if (!privateKey || !publicKey) {
            throw new AppError(400, '必须提供 privateKey 和 publicKey 用于 ECDSA 签名。请先用 POST /api/wallet/new 生成钱包。', 'MISSING_CREDENTIALS');
        }

        const tx = new Transaction(
            from, to, Number(amount), Number(fee) || 0, note || '', currency
        );
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
            message: `[${savedTx.currency || 'STC'}] 交易已通过 ECDSA 签名验证，已加入交易池`,
            transaction: savedTx,
            poolCount: starCoin.pendingTransactions.length
        });
    }));

    // ============================================================
    // 3. 查询地址余额（返回所有币种：{ STC, cBTC, cETH }）
    // ============================================================
    router.get('/balance/:address', wrapAsync(async (req, res) => {
        const address = req.params.address;
        if (!address || address.length < 2) {
            throw new AppError(400, '无效的地址格式', 'INVALID_ADDRESS');
        }

        // 获取多币种余额；若不支持 getAllBalances 则回退到 getBalance
        let balances;
        let totalBalances;
        if (typeof starCoin.getAllBalances === 'function') {
            balances = starCoin.getAllBalances(address);
            totalBalances = starCoin.getAllBalances(address, true);
        } else {
            const bal = Number(starCoin.getBalance(address, false)) || 0;
            const total = Number(starCoin.getBalance(address, true)) || 0;
            balances = { STC: bal, cBTC: 0, cETH: 0 };
            totalBalances = { STC: total, cBTC: 0, cETH: 0 };
        }

        // 获取锁定奖励：支持对象形式（各币种）或数字形式（仅 STC）
        let lockedRewardsObj = {};
        let lockedRewardsNum = 0;
        try {
            const lr = starCoin.getLockedRewards(address, 'ALL');
            if (lr && typeof lr === 'object') {
                lockedRewardsObj = lr;
                lockedRewardsNum = Number(lr.STC) || 0;
            } else {
                lockedRewardsNum = Number(lr) || 0;
                lockedRewardsObj = { STC: lockedRewardsNum, cBTC: 0, cETH: 0 };
            }
        } catch (e) {
            lockedRewardsNum = 0;
            lockedRewardsObj = { STC: 0, cBTC: 0, cETH: 0 };
        }

        const pendingInPool = starCoin.pendingTransactions
            .filter(tx => tx.from === address || tx.to === address)
            .length;

        res.json({
            success: true,
            address: address,
            balances: balances,
            totalBalances: totalBalances,
            lockedRewards: lockedRewardsNum,           // 数字，兼容旧调用方
            lockedRewardsByCurrency: lockedRewardsObj, // 对象，新字段
            balance: Number(balances.STC) || 0,
            totalBalance: Number(totalBalances.STC) || 0,
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