const express = require('express');
const bip39 = require('bip39');
const { AppError, wrapAsync } = require('./error-handler');
const { requireLegacyWallet } = require('../middleware/access-control');
const { createHdContext, deriveAddresses, deriveAddress, discoverAddresses, integer, MAX_INDEX, MAX_BATCH } = require('../hd-wallet');

module.exports = function createHdRoutes(starCoin) {
    const router = express.Router();
    router.use(requireLegacyWallet);
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

    function hdOperation(handler) {
        return wrapAsync(async (req, res) => {
            let result;
            try { result = handler(req.body || {}); }
            catch (err) { throw new AppError(400, err.message, 'INVALID_HD_WALLET'); }
            res.json({ success: true, ...result });
        });
    }

    router.post('/new', hdOperation(body => {
        const strength = body.strength ?? 128;
        if (strength !== 128 && strength !== 256) throw new Error('strength 仅支持 128 或 256');
        const context = createHdContext(bip39.generateMnemonic(strength), body.passphrase, body.scheme, body.basePath);
        return { mnemonic: context.mnemonic, ...deriveAddresses(context) };
    }));

    router.post('/derive', hdOperation(body => {
        const context = createHdContext(body.mnemonic, body.passphrase, body.scheme, body.basePath);
        if (body.indices !== undefined) {
            if (!Array.isArray(body.indices) || body.indices.length < 1 || body.indices.length > MAX_BATCH) {
                throw new Error('indices 必须包含 1 到 100 个地址索引');
            }
            const indices = [...new Set(body.indices.map(i => integer(i, 'index', 0, MAX_INDEX)))];
            const wallets = indices.map(i => deriveAddress(context, i));
            return { root: context.root, wallets, nextIndex: Math.max(...wallets.map(w => w.index)) + 1 };
        }
        return deriveAddresses(context, body.startIndex, body.count);
    }));

    router.post('/import', hdOperation(body => {
        const context = createHdContext(body.mnemonic, body.passphrase, body.scheme, body.basePath);
        const used = new Set();
        // Include incoming/outgoing history and pending transactions, irrespective of balance.
        for (const block of starCoin.chain || []) {
            for (const tx of block.transactions || []) { used.add(tx.from); used.add(tx.to); }
        }
        for (const tx of starCoin.pendingTransactions || []) { used.add(tx.from); used.add(tx.to); }
        return discoverAddresses(context, address => used.has(address), body);
    }));
    return router;
};
