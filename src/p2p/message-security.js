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
const height = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === 'string' && value.length === 64;
const requestId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const validBlock = block => object(block) && Array.isArray(block.transactions)
    && block.transactions.length <= config.P2P_MAX_TRANSACTIONS;
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
        case types.SYNC_REQUEST:
            if (message.requestId === undefined) break; // Small legacy requests still receive a summary.
            if (!requestId(message.requestId) || !Array.isArray(message.locator) || !message.locator.length
                || message.locator.length > 64 || message.locator.some(entry => !object(entry) || !height(entry.index) || !hash(entry.hash)))
                throw new Error('invalid sync request');
            break;
        case types.CHAIN_SUMMARY:
            if ((message.requestId !== undefined && !requestId(message.requestId)) || !height(message.length) || !message.length
                || !hash(message.latestHash) || (message.ancestor !== null && (!object(message.ancestor)
                    || !height(message.ancestor.index) || !hash(message.ancestor.hash)))) throw new Error('invalid chain summary');
            break;
        case types.QUERY_BLOCKS:
        case types.BLOCKS:
            if (!requestId(message.requestId) || !height(message.start) || !height(message.length)
                || message.start >= message.length || !hash(message.latestHash)) throw new Error('invalid block range');
            if (message.type === types.QUERY_BLOCKS) {
                if (!height(message.offset) || message.offset > Math.min(config.P2P_SYNC_MAX_BYTES, 64 * 1024 * 1024))
                    throw new Error('invalid fragment offset');
            } else if (message.data !== undefined) {
                if (message.blocks !== undefined || !height(message.offset) || !height(message.total) || !message.total
                    || message.offset >= message.total || message.total > Math.min(config.P2P_SYNC_MAX_BYTES, 64 * 1024 * 1024)
                    || typeof message.data !== 'string' || !message.data.length
                    || message.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data))
                    throw new Error('invalid block fragment');
            } else if (!Array.isArray(message.blocks) || !message.blocks.length || message.blocks.length > 256
                || message.blocks.some(block => !validBlock(block))) throw new Error('invalid blocks');
            break;
        case types.SYNC_RESTART:
            if (!requestId(message.requestId)) throw new Error('invalid sync restart');
            break;
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
