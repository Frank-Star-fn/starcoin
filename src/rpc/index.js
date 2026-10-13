const express = require('express');
const { keccak256 } = require('ethers');
const config = require('../config');
const { toUnits } = require('../protocol');
const { withdrawalData } = require('../evm/external-transaction');
const { nextBaseFee } = require('../evm/rpc-settings');
const { RpcView } = require('./view');
const { RpcError, q, quantity, integer, hash32, options, address, hex } = require('./codec');

function createRpc(chain, p2p, broadcast) {
    const router = express.Router(), view = new RpcView(chain), limits = new Map();
    const writes = new Set(['eth_sendRawTransaction', 'starcoin_submitWithdrawal']);
    const counts = { eth_chainId: [0, 0], net_version: [0, 0], net_listening: [0, 0], web3_clientVersion: [0, 0], web3_sha3: [1, 1],
        eth_blockNumber: [0, 0], eth_syncing: [0, 0], eth_accounts: [0, 0], eth_coinbase: [0, 0], eth_gasPrice: [0, 0], eth_maxPriorityFeePerGas: [0, 0],
        eth_getBalance: [1, 2], eth_getTransactionCount: [1, 2], eth_getCode: [1, 2], eth_getStorageAt: [2, 3],
        eth_getBlockByNumber: [1, 2], eth_getBlockByHash: [1, 2], eth_getTransactionByHash: [1, 1], eth_getTransactionReceipt: [1, 1],
        eth_getBlockTransactionCountByNumber: [1, 1], eth_getBlockTransactionCountByHash: [1, 1],
        eth_getTransactionByBlockNumberAndIndex: [2, 2], eth_getTransactionByBlockHashAndIndex: [2, 2],
        eth_getUncleCountByBlockNumber: [1, 1], eth_getUncleCountByBlockHash: [1, 1], eth_getLogs: [1, 1], eth_feeHistory: [2, 3],
        eth_call: [1, 2], eth_estimateGas: [1, 2], eth_sendRawTransaction: [1, 1], starcoin_getNetwork: [0, 0],
        starcoin_getBridgeNonce: [1, 2], starcoin_getWithdrawalTypedData: [1, 1], starcoin_submitWithdrawal: [1, 1], starcoin_getWithdrawalReceipt: [1, 1] };
    const cleanup = setInterval(() => { const now = Date.now(); for (const [key, bucket] of limits) {
        if (bucket.at(-1) < now - Math.max(config.RATE_LIMIT_GLOBAL_WINDOW_MS, config.RATE_LIMIT_WRITE_WINDOW_MS)) limits.delete(key);
    } }, 60000); cleanup.unref();
    function checkRate(ip, method) {
        const consume = (key, window, max) => {
            const now = Date.now(), bucket = (limits.get(key) || []).filter(t => t > now - window);
            if (bucket.length >= max) throw new RpcError(-32005, '请求过于频繁，请稍后再试');
            bucket.push(now); limits.set(key, bucket);
        };
        consume(ip + ':all', config.RATE_LIMIT_GLOBAL_WINDOW_MS, config.RATE_LIMIT_GLOBAL_MAX);
        if (writes.has(method)) consume(ip + ':write', config.RATE_LIMIT_WRITE_WINDOW_MS, config.RATE_LIMIT_WRITE_MAX);
    }
    const announce = tx => { p2p.broadcastTransaction(tx); broadcast('newTransaction', { txId: tx.id, pendingCount: chain.pendingTransactions.length }); };
    const settings = () => ({ ...chain.consensus.evm, priorityFeeWei: chain.consensus.rpc.priorityFeeWei });
    function byHash(value) { const hash = hash32(value); return chain.chain.find(block => '0x' + block.hash === hash); }
    function rpcFailure(error) {
        if (error instanceof RpcError) return { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) };
        return { code: -32000, message: error.message || '请求失败' };
    }
    async function estimate(value, tag) {
        const state = await view.stateAt(tag ?? 'pending'), input = options(value, state.context, settings());
        let high = BigInt(input.gasLimit);
        if (input.from) {
            const available = await state.engine.balance(input.from) - BigInt(input.valueWei);
            if (available < 0n) throw new RpcError(-32000, 'insufficient funds for value');
            const price = BigInt(input.maxFeePerGas ?? input.gasPrice);
            if (price > 0n && available / price < high) high = available / price;
        }
        const attempt = gas => state.engine.simulate({ ...input, gasLimit: gas.toString() }, state.context);
        const result = await attempt(high);
        if (!result.status) throw new RpcError(3, 'execution reverted: ' + result.error, result.returnData);
        let low = 20999n;
        while (high - low > 1n) {
            const middle = (low + high) / 2n;
            try { const result = await attempt(middle); if (result.status) high = middle; else low = middle; } catch { low = middle; }
        }
        return q(high);
    }
    function logs(filter) {
        if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new RpcError(-32602, '无效日志过滤器');
        if (filter.blockHash !== undefined && (filter.fromBlock !== undefined || filter.toBlock !== undefined)) throw new RpcError(-32602, 'blockHash 不能与高度范围一起使用');
        const block = filter.blockHash === undefined ? null : byHash(filter.blockHash);
        if (filter.blockHash !== undefined && !block) throw new RpcError(-32000, '区块不存在');
        const from = block ? block.index : view.height(filter.fromBlock ?? 'latest'), to = block ? block.index : view.height(filter.toBlock ?? 'latest');
        if (to < from || to - from > 2000) throw new RpcError(-32602, '日志范围必须在 2000 个高度内');
        const addresses = filter.address === undefined ? [] : (Array.isArray(filter.address) ? filter.address : [filter.address]).map(address);
        if (addresses.length > 100 || (filter.topics !== undefined && (!Array.isArray(filter.topics) || filter.topics.length > 4))) throw new RpcError(-32602, '地址或 topic 过滤器过大');
        const topics = (filter.topics || []).map(topic => topic === null ? null : (Array.isArray(topic) ? topic : [topic]).map(hash32));
        const result = [];
        for (const block of chain.chain.slice(from, Math.min(to + 1, chain.chain.length))) for (const log of view.blockLogs(block)) {
            if (addresses.length && !addresses.includes(log.address)) continue;
            if (!topics.every((topic, index) => topic === null || topic.includes(log.topics[index]))) continue;
            if (result.length >= 10000) throw new RpcError(-32005, '日志过多，请缩小范围'); result.push(log);
        }
        return result;
    }
    function feeHistory(count, newest, percentiles = []) {
        count = integer(count, 'blockCount');
        if (count < 1 || count > 1024 || !Array.isArray(percentiles) || percentiles.length > 20
            || percentiles.some((p, i) => typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100 || (i && p < percentiles[i - 1]))) throw new RpcError(-32602, '无效费用历史参数');
        const to = view.height(newest); if (to >= chain.chain.length) throw new RpcError(-32000, '区块不存在');
        const from = Math.max(0, to - count + 1), blocks = chain.chain.slice(from, to + 1), last = blocks.at(-1);
        const reward = blocks.map(block => {
            const base = BigInt(block.baseFeePerGas || '0');
            const receipts = view.records(block.transactions).map(tx => chain._evaluation.receipts.get(tx.id)).filter(Boolean);
            const weighted = receipts.map(receipt => ({ gas: BigInt(receipt.gasUsed), tip: BigInt(receipt.gasPriceWei) - base })).sort((a, b) => a.tip < b.tip ? -1 : a.tip > b.tip ? 1 : 0);
            const total = weighted.reduce((sum, item) => sum + item.gas, 0n);
            return percentiles.map(p => { if (!weighted.length) return '0x0'; let gas = 0n;
                const target = total * BigInt(Math.round(p * 10000)) / 1000000n;
                for (const item of weighted) { gas += item.gas; if (gas >= target) return q(item.tip); } return q(weighted.at(-1).tip); });
        });
        return { oldestBlock: q(from), baseFeePerGas: [...blocks.map(block => q(block.baseFeePerGas || '0')),
            q(nextBaseFee(last, chain.consensus.rpc, to + 1, chain.consensus.evm.blockGasLimit))],
            gasUsedRatio: blocks.map(block => Number(block.evmGasUsed || 0) / chain.consensus.evm.blockGasLimit), ...(percentiles.length ? { reward } : {}) };
    }
    async function dispatch(method, params) {
        await chain.ready;
        if (!chain.rpcEnabled) throw new RpcError(-32000, '当前节点未启用 MetaMask 协议');
        const range = counts[method]; if (!range) throw new RpcError(-32601, 'Method not found: ' + method);
        if (!Array.isArray(params) || params.length < range[0] || params.length > range[1]) throw new RpcError(-32602, 'Invalid params');
        const [first, second, third] = params, context = chain.consensus.context(chain.chain);
        switch (method) {
            case 'eth_chainId': return q(chain.consensus.evm.chainId);
            case 'net_version': return String(chain.consensus.evm.chainId);
            case 'net_listening': return true;
            case 'web3_clientVersion': return 'StarCoin/MetaMask-v4';
            case 'web3_sha3': return keccak256(hex(first));
            case 'eth_blockNumber': return q(chain.chain.length - 1);
            case 'eth_syncing': {
                const sync = p2p.getSyncState?.(); if (!sync?.isSyncing) return false;
                return { startingBlock: '0x0', currentBlock: q(chain.chain.length - 1),
                    highestBlock: q(Math.max(chain.chain.length - 1, ...(sync.candidates || []).map(item => item.length - 1))) };
            }
            case 'eth_accounts': return [];
            case 'eth_coinbase': return '0x000000000000000000000000000000000000dead';
            case 'eth_gasPrice': return q(BigInt(context.baseFeePerGas) + BigInt(chain.consensus.rpc.priorityFeeWei));
            case 'eth_maxPriorityFeePerGas': return q(chain.consensus.rpc.priorityFeeWei);
            case 'eth_getBalance': return q(await (await view.stateAt(second)).engine.balance(address(first)));
            case 'eth_getTransactionCount': return q(await (await view.stateAt(second)).engine.nonce(address(first)));
            case 'eth_getCode': return (await view.stateAt(second)).engine.code(address(first));
            case 'eth_getStorageAt': return (await view.stateAt(third)).engine.storage(address(first), quantity(second, 'slot').toString());
            case 'eth_getBlockByNumber': return view.block(first, second ?? false);
            case 'eth_getBlockByHash': { const block = byHash(first); return block ? view.block(q(block.index), second ?? false) : null; }
            case 'eth_getTransactionByHash': { const found = view.find(first); return found ? view.tx(found.tx, found.block, found.index) : null; }
            case 'eth_getTransactionReceipt': return view.receipt(first);
            case 'eth_getBlockTransactionCountByNumber': { const block = view.blockFor(first); return block ? q(view.records(first === 'pending' ? chain.pendingTransactions : block.transactions).length) : null; }
            case 'eth_getBlockTransactionCountByHash': { const block = byHash(first); return block ? q(view.records(block.transactions).length) : null; }
            case 'eth_getTransactionByBlockNumberAndIndex': case 'eth_getTransactionByBlockHashAndIndex': {
                const block = method.includes('Hash') ? byHash(first) : view.blockFor(first), index = integer(second, 'transactionIndex');
                if (!block) return null;
                const tx = view.records(first === 'pending' ? chain.pendingTransactions : block.transactions)[index];
                return tx ? view.tx(tx, first === 'pending' ? null : block, index) : null;
            }
            case 'eth_getUncleCountByBlockNumber': return view.blockFor(first) ? '0x0' : null;
            case 'eth_getUncleCountByBlockHash': return byHash(first) ? '0x0' : null;
            case 'eth_getLogs': return logs(first);
            case 'eth_feeHistory': return feeHistory(first, second, third);
            case 'eth_estimateGas': return estimate(first, second);
            case 'eth_call': {
                const state = await view.stateAt(second), input = options(first, state.context, settings(), true);
                const result = await state.engine.call(input, state.context);
                if (!result.status) throw new RpcError(3, 'execution reverted: ' + result.error, result.returnData); return result.returnData;
            }
            case 'eth_sendRawTransaction': {
                const tx = await chain.submitRaw(hex(first)); announce(tx); return keccak256(tx.rawTransaction);
            }
            case 'starcoin_getNetwork': return { chainId: q(chain.consensus.evm.chainId), chainName: 'StarCoin', nativeCurrency: { name: 'StarCoin', symbol: 'STC', decimals: 18 },
                activationHeight: chain.consensus.rpc.activationHeight, active: chain.chain.length >= chain.consensus.rpc.activationHeight,
                gasLimit: q(chain.consensus.evm.transactionGasLimit), baseFeePerGas: q(context.baseFeePerGas), priorityFeePerGas: q(chain.consensus.rpc.priorityFeeWei) };
            case 'starcoin_getBridgeNonce': return q((await view.stateAt(second)).state.bridgeNonces.get(address(first)) || 0n);
            case 'starcoin_getWithdrawalTypedData': {
                if (!first || typeof first !== 'object') throw new RpcError(-32602, '必须提供取回参数');
                const state = await view.stateAt('pending'), owner = address(first.owner), amountUnits = toUnits(first.amount).toString();
                if (BigInt(amountUnits) <= 0n) throw new RpcError(-32602, '取回金额必须大于 0');
                const deadline = first.deadline === undefined ? String(Math.floor(Date.now() / 1000) + 1800) : quantity(first.deadline, 'deadline').toString();
                const data = withdrawalData(chain.consensus, owner, first.nativeAddress, amountUnits, (state.state.bridgeNonces.get(owner) || 0n).toString(), deadline);
                return { ...data, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'salt', type: 'bytes32' }], ...data.types } };
            }
            case 'starcoin_submitWithdrawal': {
                if (!first || typeof first !== 'object') throw new RpcError(-32602, '必须提供签名授权');
                const tx = await chain.submitWithdrawal(first.message, first.signature); announce(tx); return '0x' + tx.id;
            }
            case 'starcoin_getWithdrawalReceipt': return chain.receipt(hash32(first).slice(2));
        }
    }
    async function handle(request, ip) {
        const validId = id => id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
        if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0'
            || typeof request.method !== 'string' || (Object.hasOwn(request, 'id') && !validId(request.id))) {
            return { jsonrpc: '2.0', id: validId(request?.id) ? request.id : null, error: { code: -32600, message: 'Invalid Request' } };
        }
        const notification = !Object.hasOwn(request, 'id');
        try {
            checkRate(ip, request.method);
            const result = await dispatch(request.method, request.params ?? []);
            return notification ? null : { jsonrpc: '2.0', id: request.id, result };
        } catch (error) { return notification ? null : { jsonrpc: '2.0', id: request.id, error: rpcFailure(error) }; }
    }
    router.use((_req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store'); next(); });
    router.options('/', (_req, res) => { res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); res.sendStatus(204); });
    router.use(express.json({ limit: '1mb' }));
    router.use((error, _req, res, _next) => res.status(error.status || 400).json({ jsonrpc: '2.0', id: null,
        error: { code: error.type === 'entity.too.large' ? -32600 : -32700, message: error.type === 'entity.too.large' ? 'Request too large' : 'Parse error' } }));
    router.post('/', async (req, res) => {
        try {
            const input = req.body, batch = Array.isArray(input), responses = [];
            if (batch && (!input.length || input.length > 20)) return res.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch size must be 1–20' } });
            for (const item of batch ? input : [input]) { const response = await handle(item, req.ip); if (response) responses.push(response); }
            if (!responses.length) return res.sendStatus(204); res.json(batch ? responses : responses[0]);
        } catch { res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }); }
    });
    return router;
}
module.exports = createRpc;
