const config = require('../config');

function validPeerUrl(value) {
    if (typeof value !== 'string' || value.length > 512) return false;
    try {
        const url = new URL(value);
        return ['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password
            && url.pathname === '/' && !url.search && !url.hash
            && config.P2P_ALLOWED_HOSTS.includes(url.hostname.toLowerCase());
    } catch { return false; }
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validateMessage(message, types) {
    if (!object(message) || !Object.values(types).includes(message.type)) throw new Error('invalid message type');
    const stack = [[message, 0]]; let count = 0;
    while (stack.length) {
        const [value, depth] = stack.pop();
        if (++count > 250000 || depth > 32) throw new Error('message nesting limit');
        if (value && typeof value === 'object') {
            if (Array.isArray(value) && value.length > config.P2P_MAX_CHAIN_BLOCKS) throw new Error('array limit');
            for (const child of Object.values(value)) stack.push([child, depth + 1]);
        }
    }
    switch (message.type) {
        case types.CHAIN:
            if (!Array.isArray(message.chain) || !message.chain.length || message.chain.length > config.P2P_MAX_CHAIN_BLOCKS
                || message.chain.some(block => !object(block) || !Array.isArray(block.transactions)
                    || block.transactions.length > config.P2P_MAX_TRANSACTIONS)) throw new Error('invalid chain');
            break;
        case types.BLOCK:
            if (!object(message.block) || !Array.isArray(message.block.transactions)
                || message.block.transactions.length > config.P2P_MAX_TRANSACTIONS) throw new Error('invalid block');
            break;
        case types.TRANSACTION:
            if (!object(message.transaction)) throw new Error('invalid transaction');
            break;
        case types.PENDING_TXS:
            if (!Array.isArray(message.transactions) || message.transactions.length > config.P2P_MAX_TRANSACTIONS
                || message.transactions.some(tx => !object(tx))) throw new Error('invalid transactions');
            break;
        case types.NODE_INFO:
            if (!object(message.node) || !validPeerUrl(message.node.url)) throw new Error('invalid peer');
            break;
        case types.NODE_LIST:
            if (message.nodes !== undefined && (!Array.isArray(message.nodes) || message.nodes.length > config.P2P_MAX_CONNECTIONS
                || message.nodes.some(url => !validPeerUrl(url)))) throw new Error('invalid peers');
            break;
    }
    return message;
}

// All socket paths share this boundary. The handler is invoked inside a promise so
// synchronous throws and asynchronous rejections are both contained.
function receiveMessages(ws, types, handler, onError) {
    let windowStart = Date.now(), messages = 0, pending = 0, rejected = false, tail = Promise.resolve();
    function fail(code, reason) {
        if (rejected) return;
        rejected = true;
        onError(reason);
        ws.close(code, 'Invalid peer message');
    }
    ws.on('message', (bytes, binary) => {
        if (rejected) return;
        let parsed;
        try {
            const now = Date.now();
            if (now - windowStart >= 10000) { windowStart = now; messages = 0; }
            if (++messages > config.P2P_MAX_MESSAGES || pending >= 8) return fail(1008, 'message rate limit');
            if (binary || Buffer.byteLength(bytes) > config.P2P_MAX_PAYLOAD) return fail(1009, 'payload limit');
            parsed = validateMessage(JSON.parse(bytes.toString()), types);
        } catch { return fail(1007, 'malformed message'); }
        pending++;
        tail = tail.then(() => rejected ? undefined : handler(parsed)).catch(() => fail(1008, 'message handler failed'))
            .finally(() => { pending--; });
    });
}
module.exports = { validPeerUrl, validateMessage, receiveMessages };
