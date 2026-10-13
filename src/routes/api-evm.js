const express = require('express');
const { formatEther } = require('ethers');
const { address, hex, uint, evmAddressFromPublicKey, evmAddressFromPem } = require('../evm/engine');
const { AppError, wrapAsync } = require('./error-handler');

function createEvmRoutes(chain, p2p, broadcast) {
    const router = express.Router();
    const route = handler => wrapAsync(async (req, res) => {
        if (!chain.evmEnabled) throw new AppError(503, '当前节点未启用 EVM', 'EVM_DISABLED');
        await chain.ready;
        try { await handler(req, res); }
        catch (error) { if (error instanceof AppError) throw error; throw new AppError(400, error.message, 'EVM_REJECTED'); }
    });
    const context = () => chain.consensus.context(chain.chain);
    const credentials = body => {
        if (typeof body.privateKey !== 'string' || body.privateKey.length > 4096) throw new Error('必须提供 PEM privateKey');
        return body.privateKey;
    };
    // Whitelist transaction fields: callers cannot choose consensus Gas price or nonce.
    const transactionOptions = body => ({ to: body.to, data: hex(body.data ?? '0x'),
        gasLimit: body.gasLimit, valueWei: uint(body.valueWei ?? '0', 'valueWei').toString() });
    const submit = async (req, res, kind) => {
        const options = kind === 'evm' ? transactionOptions(req.body) : {
            amount: req.body.amount, evmAddress: req.body.evmAddress, nativeAddress: req.body.nativeAddress
        };
        const tx = await chain.submitEvm(credentials(req.body), { ...options, kind });
        p2p.broadcastTransaction(tx);
        broadcast('newTransaction', { txId: tx.id, pendingCount: chain.pendingTransactions.length });
        res.json({ success: true, transaction: tx, receipt: chain.receipt(tx.id) });
    };
    router.get('/evm/status', route(async (_req, res) => {
        const { fingerprint, ...settings } = chain.consensus.evm;
        res.json({ success: true, ...settings, active: chain.chain.length >= settings.activationHeight,
            metamask: chain.consensus.rpc ? { ...chain.consensus.rpc, rpcUrl: '/rpc', rpcConsensusHash: chain.consensus.rpcFingerprint,
                baseFeePerGas: context().baseFeePerGas, priorityFeeWei: chain.consensus.rpc.priorityFeeWei } : null,
            evmConsensusHash: chain.consensus.evmFingerprint, stateRoot: chain._evaluation.evmStateRoot,
            bridgeLockedWei: chain._evaluation.state.bridgeLockedWei.toString(), burnedWei: chain._evaluation.state.evmBurnedWei.toString() });
    }));
    router.post('/evm/address', route(async (req, res) => {
        if (typeof req.body.publicKey !== 'string' || !/^[0-9a-fA-F]{16,1024}$/.test(req.body.publicKey)) throw new Error('必须提供 SPKI 十六进制 publicKey');
        res.json({ success: true, address: evmAddressFromPublicKey(req.body.publicKey) });
    }));
    router.get('/evm/account/:address', route(async (req, res) => {
        const target = address(req.params.address), engine = chain._evaluation.engine;
        const stateRoot = chain._evaluation.evmStateRoot;
        const account = await engine.account(target);
        res.json({ success: true, address: target, balanceWei: account.balance.toString(), balanceSTC: formatEther(account.balance),
            nonce: account.nonce.toString(), code: await engine.code(target), stateRoot });
    }));
    router.get('/evm/storage/:address/:slot', route(async (req, res) => {
        res.json({ success: true, value: await chain._evaluation.engine.storage(req.params.address, req.params.slot) });
    }));
    router.post('/evm/deposit', route((req, res) => submit(req, res, 'deposit')));
    router.post('/evm/withdraw', route((req, res) => submit(req, res, 'withdraw')));
    router.post('/evm/transaction', route((req, res) => submit(req, res, 'evm')));
    router.post('/evm/call', route(async (req, res) => {
        const result = await chain._evaluation.engine.call({ ...transactionOptions(req.body), from: req.body.from }, context());
        res.json({ success: true, ...result });
    }));
    router.post('/evm/estimate', route(async (req, res) => {
        const pem = credentials(req.body), engine = chain._evaluation.engine, from = evmAddressFromPem(pem);
        const stateRoot = chain._evaluation.evmStateRoot;
        const options = { ...transactionOptions(req.body), nonce: await engine.nonce(from) }, block = context();
        const suggested = BigInt(block.baseFeePerGas) + BigInt(chain.consensus.rpc?.priorityFeeWei || '0');
        const gasPrice = suggested > BigInt(chain.consensus.evm.gasPriceWei) ? suggested : BigInt(chain.consensus.evm.gasPriceWei);
        const requested = uint(String(options.gasLimit ?? chain.consensus.evm.transactionGasLimit), 'gasLimit');
        if (requested > BigInt(chain.consensus.evm.transactionGasLimit)) throw new Error('估算 Gas 上限过大');
        const available = await engine.balance(from) - BigInt(options.valueWei);
        if (available < 0n) throw new Error('EVM value 余额不足');
        const affordable = available / gasPrice;
        const limit = requested < affordable ? requested : affordable;
        const attempt = async gas => {
            return engine.simulate({ ...options, from, gasPrice: gasPrice.toString(), gasLimit: gas.toString() }, block);
        };
        const result = await attempt(limit);
        if (!result.status) throw new AppError(400, '模拟执行失败：' + result.error, 'EVM_EXECUTION_FAILED', result);
        let low = 20999n, high = limit;
        while (high - low > 1n) {
            const middle = (low + high) / 2n;
            try { const receipt = await attempt(middle); if (receipt.status) high = middle; else low = middle; }
            catch { low = middle; }
        }
        res.json({ success: true, gasLimit: high.toString(), gasUsed: result.gasUsed,
            gasPriceWei: gasPrice.toString(), maxFeeWei: (high * gasPrice).toString(),
            stateRoot });
    }));
    router.get('/evm/receipt/:id', route(async (req, res) => {
        if (!/^[0-9a-f]{64}$/.test(req.params.id)) throw new Error('id 必须是原生交易的 64 位十六进制 ID');
        res.json({ success: true, receipt: chain.receipt(req.params.id) });
    }));
    router.get('/evm/logs', route(async (req, res) => {
        const height = value => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error('区块高度无效'); return n; };
        const from = height(req.query.fromBlock ?? Math.max(0, chain.chain.length - 100));
        const to = height(req.query.toBlock ?? chain.chain.length - 1);
        if (to < from || to - from > 2000) throw new Error('日志查询范围必须在 2000 个区块以内');
        const target = req.query.address === undefined ? null : address(req.query.address);
        const topic = req.query.topic === undefined ? null : hex(req.query.topic, 32);
        if (topic && topic.length !== 66) throw new Error('事件 topic 必须为 32 字节');
        const logs = [];
        for (const receipt of chain._evaluation.receipts.values()) {
            if (receipt.blockIndex < from || receipt.blockIndex > to) continue;
            for (const log of receipt.logs) if ((!target || target === log.address) && (!topic || topic === log.topics[0])) {
                if (logs.length >= 10000) throw new Error('日志过多，请缩小查询范围');
                logs.push({ ...log, id: receipt.id, transactionHash: receipt.transactionHash, blockIndex: receipt.blockIndex, blockHash: receipt.blockHash });
            }
        }
        res.json({ success: true, logs });
    }));
    return router;
}
module.exports = createEvmRoutes;
