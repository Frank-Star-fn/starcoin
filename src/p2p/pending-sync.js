const { createHash } = require('crypto');
const config = require('../config');
const { messageBudget } = require('../mempool-policy');
const { settle } = require('./settle');

const bytes = message => Buffer.byteLength(JSON.stringify(message), 'utf8');

function createPendingSync(network, chain, merge, paused = () => false) {
    const states = new WeakMap(), watched = new WeakSet();
    const interval = () => Math.ceil(20000 / Math.max(1, config.P2P_MAX_MESSAGES - 20));

    function clear(ws) {
        clearTimeout(states.get(ws)?.timer);
        states.delete(ws);
    }

    function page(request = {}) {
        const pending = chain.pendingTransactions;
        const poolId = createHash('sha256').update(JSON.stringify(pending.map(tx => tx.id))).digest('hex');
        const cursor = request.poolId === poolId ? Math.min(request.cursor || 0, pending.length) : 0;
        const message = { type: 'PENDING_TXS', transactions: [], fromNode: network.nodeInfo.url,
            poolId, cursor, next: Number.MAX_SAFE_INTEGER };
        let size = bytes(message);
        const count = Math.min(config.P2P_MAX_TRANSACTIONS, config.P2P_MAX_CHAIN_BLOCKS);
        for (let i = cursor; i < pending.length && message.transactions.length < count; i++) {
            const nextSize = bytes(pending[i]) + (message.transactions.length ? 1 : 0);
            if (size + nextSize > messageBudget()) break;
            message.transactions.push(pending[i]); size += nextSize;
        }
        const next = cursor + message.transactions.length;
        if (next < pending.length && next === cursor) throw new Error('交易超过 P2P 分页容量');
        message.next = next < pending.length ? next : null;
        // Preserve the existing wire format when a complete pool fits in one response.
        if (!request.poolId && cursor === 0 && message.next === null) {
            delete message.poolId; delete message.cursor; delete message.next;
        }
        return message;
    }

    function requestNext(ws, state) {
        clearTimeout(state.timer);
        state.timer = setTimeout(() => {
            if (states.get(ws) !== state) return;
            if (paused(ws)) return requestNext(ws, state);
            network.sendMessage(ws, { type: 'QUERY_PENDING_TXS', fromNode: network.nodeInfo.url,
                ...(state.poolId ? { poolId: state.poolId, cursor: state.cursor } : {}) });
        }, interval());
        state.timer.unref?.();
    }

    function receive(ws, message) {
        if (!watched.has(ws)) { watched.add(ws); ws.once?.('close', () => clear(ws)); }
        if (paused(ws)) {
            clear(ws);
            const state = { cursor: 0, count: 0, bytes: 2, restarts: 0 };
            states.set(ws, state); requestNext(ws, state);
            return;
        }
        if (message.poolId === undefined) {
            clear(ws);
            return merge(message.transactions, message.fromNode);
        }
        let state = states.get(ws);
        if (!state?.poolId || (message.cursor === 0 && message.poolId !== state.poolId)) {
            const restarts = state?.poolId ? state.restarts + 1 : 0;
            if (message.cursor !== 0 || restarts > 2) { clear(ws); return; }
            clear(ws);
            state = { poolId: message.poolId, cursor: 0, count: 0, bytes: 2, restarts };
            states.set(ws, state);
        }
        if (message.poolId !== state.poolId || message.cursor !== state.cursor) return;
        clearTimeout(state.timer);
        state.bytes += message.transactions.reduce((size, tx, index) => size + bytes(tx) + (state.count + index ? 1 : 0), 0);
        state.count += message.transactions.length;
        if (state.count > config.MEMPOOL_MAX_TXS || state.bytes > config.MEMPOOL_MAX_BYTES) { clear(ws); return; }
        return settle(merge(message.transactions, message.fromNode), () => {
            if (states.get(ws) !== state) return;
            if (message.next === null) { clear(ws); return; }
            state.cursor = message.next;
            requestNext(ws, state);
        });
    }

    return { receive, reply: (ws, request) => network.sendMessage(ws, page(request)),
        broadcast: () => network.broadcast(page()) };
}

module.exports = { createPendingSync };
