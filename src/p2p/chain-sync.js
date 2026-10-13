const { randomUUID } = require('crypto');
const config = require('../config');
const { validateMessage } = require('./message-security');
const { settle } = require('./settle');

const bytes = message => Buffer.byteLength(JSON.stringify(message), 'utf8');
// Leave room for control messages, and stay below the receiver's JSON traversal limit.
const budget = () => Math.min(1024 * 1024, Math.floor(config.P2P_MAX_PAYLOAD * 0.75));
const maxBlockBytes = () => Math.min(config.P2P_SYNC_MAX_BYTES, 64 * 1024 * 1024);

function locator(chain) {
    const result = []; let height = chain.length - 1, step = 1;
    while (height > 0) {
        result.push({ index: height, hash: chain[height].hash });
        if (result.length >= 10) step *= 2;
        height = Math.max(0, height - step);
    }
    result.push({ index: 0, hash: chain[0].hash });
    return result;
}

function createChainSync(network, chain, hooks = {}) {
    const states = new Map(), watched = new WeakSet();
    function clear(ws) {
        const state = states.get(ws);
        if (!state) return;
        clearTimeout(state.timer); clearTimeout(state.nextTimer);
        states.delete(ws);
        return state;
    }
    function fail(ws) {
        const state = clear(ws);
        if (state) hooks.onFailure?.(ws, state.id);
    }
    function progress(ws, state) {
        clearTimeout(state.timer);
        state.timer = setTimeout(() => fail(ws), config.SYNC_TIMEOUT);
        state.timer.unref?.();
        hooks.onProgress?.(ws, state.id);
    }
    function request(ws, id = randomUUID(), retries = 0) {
        clear(ws);
        const state = { id, retries, prefix: chain.chain.slice(), downloaded: 0, parts: [], offset: 0 };
        states.set(ws, state);
        if (!watched.has(ws)) {
            watched.add(ws);
            ws.once?.('close', () => fail(ws));
        }
        progress(ws, state);
        network.sendMessage(ws, { type: 'SYNC_REQUEST', requestId: id, locator: locator(state.prefix) });
    }
    function summary(ws, message = {}) {
        const current = chain.chain;
        const ancestor = (message.locator || []).find(entry => current[entry.index]?.hash === entry.hash);
        network.sendMessage(ws, {
            type: 'CHAIN_SUMMARY', requestId: message.requestId,
            length: current.length, latestHash: current[current.length - 1].hash,
            ancestor: ancestor || null
        });
    }
    function query(ws, state, delayed = false) {
        const send = () => {
            if (states.get(ws) !== state) return;
            progress(ws, state);
            network.sendMessage(ws, {
                type: 'QUERY_BLOCKS', requestId: state.id, start: state.next,
                length: state.length, latestHash: state.latestHash, offset: state.offset
            });
        };
        // One outstanding request per connection; pace downloads within the existing rate limit.
        if (delayed) state.nextTimer = setTimeout(send, Math.ceil(10000 / Math.max(1, config.P2P_MAX_MESSAGES - 20)));
        else send();
    }
    function finish(ws, state) {
        if (state.next !== state.length || state.candidate.at(-1)?.hash !== state.latestHash) throw new Error('incomplete chain');
        clear(ws);
        return settle(hooks.onChain(state.candidate, ws, state.id), () => {
            // The peer may have appended blocks while this pinned target was downloading.
            if (chain.getLatestBlock().hash === state.latestHash) network.sendMessage(ws, { type: 'QUERY_LATEST' });
        });
    }
    function receiveSummary(ws, message) {
        let state = states.get(ws);
        if (!message.requestId) {
            if (!state && message.latestHash !== chain.getLatestBlock().hash) request(ws);
            return;
        }
        if (!state || state.id !== message.requestId || state.candidate) return;
        const ancestor = message.ancestor;
        if (ancestor && state.prefix[ancestor.index]?.hash !== ancestor.hash) throw new Error('invalid ancestor');
        if (ancestor && ancestor.index >= message.length) throw new Error('invalid ancestor height');
        state.candidate = ancestor ? state.prefix.slice(0, ancestor.index + 1) : [];
        state.prefix = null;
        state.length = message.length; state.latestHash = message.latestHash;
        state.next = state.candidate.length;
        progress(ws, state);
        if (state.next === state.length) return finish(ws, state);
        query(ws, state);
    }
    function serve(ws, message) {
        const current = chain.chain;
        if (current[message.length - 1]?.hash !== message.latestHash) {
            network.sendMessage(ws, { type: 'SYNC_RESTART', requestId: message.requestId });
            return;
        }
        const response = { type: 'BLOCKS', requestId: message.requestId, start: message.start,
            length: message.length, latestHash: message.latestHash, blocks: [] };
        let nodes = 0;
        for (let i = message.start; i < message.length && response.blocks.length < Math.min(256, config.P2P_MAX_CHAIN_BLOCKS); i++) {
            const block = current[i];
            const encoded = Buffer.from(JSON.stringify(block), 'utf8');
            // Counting serialized values also covers class instances and toJSON implementations.
            const stack = [JSON.parse(encoded.toString())]; let count = 0;
            while (stack.length && count <= 200000) {
                const value = stack.pop(); count++;
                if (value && typeof value === 'object') stack.push(...Object.values(value));
            }
            response.blocks.push(block);
            if (nodes + count > 200000 || bytes(response) > budget()) {
                response.blocks.pop();
                if (response.blocks.length) break;
                if (encoded.length > maxBlockBytes() || message.offset >= encoded.length) throw new Error('block download limit');
                // A large single block is transported as bounded base64 fragments, not a large WS frame.
                const size = Math.max(1, Math.floor((budget() - 1024) * 0.75));
                const part = { ...response, blocks: undefined, offset: message.offset, total: encoded.length,
                    data: encoded.subarray(message.offset, message.offset + size).toString('base64') };
                if (bytes(part) > budget()) throw new Error('fragment exceeds payload budget');
                network.sendMessage(ws, part);
                return;
            }
            nodes += count;
        }
        if (message.offset || !response.blocks.length) throw new Error('invalid block range');
        network.sendMessage(ws, response);
    }
    function receive(ws, message) {
        const state = states.get(ws);
        if (!state || state.id !== message.requestId) return; // Stale responses cannot affect another transfer.
        if (!state.candidate || message.start !== state.next || message.length !== state.length
            || message.latestHash !== state.latestHash) throw new Error('unexpected block range');
        state.downloaded += bytes(message);
        if (state.downloaded > config.P2P_SYNC_MAX_BYTES) throw new Error('chain download limit');
        let blocks = message.blocks;
        if (message.data !== undefined) {
            if (message.offset !== state.offset || (state.total && state.total !== message.total)) throw new Error('unexpected fragment');
            const data = Buffer.from(message.data, 'base64');
            if (!data.length || state.offset + data.length > message.total) throw new Error('invalid fragment size');
            state.total = message.total; state.parts.push(data); state.offset += data.length;
            if (state.offset < state.total) { progress(ws, state); query(ws, state, true); return; }
            blocks = [JSON.parse(Buffer.concat(state.parts, state.total).toString('utf8'))];
            validateMessage({ type: 'BLOCK', block: blocks[0] }, { BLOCK: 'BLOCK' });
            state.parts = []; state.offset = 0; state.total = 0;
        } else if (state.offset) throw new Error('missing fragment');
        for (const block of blocks) {
            if (!block || !Array.isArray(block.transactions) || block.transactions.length > config.P2P_MAX_TRANSACTIONS
                || block.index !== state.next || typeof block.hash !== 'string' || block.hash.length !== 64
                || (state.next && block.previousHash !== state.candidate.at(-1).hash)) throw new Error('non-contiguous blocks');
            state.candidate.push(block); state.next++;
        }
        if (state.next > state.length) throw new Error('range exceeds target');
        progress(ws, state);
        if (state.next === state.length) return finish(ws, state);
        query(ws, state, true);
    }
    function handle(ws, message) {
        switch (message.type) {
            case 'QUERY_ALL': case 'SYNC_REQUEST': return summary(ws, message);
            case 'CHAIN_SUMMARY': return receiveSummary(ws, message);
            case 'QUERY_BLOCKS': return serve(ws, message);
            case 'BLOCKS': return receive(ws, message);
            case 'SYNC_RESTART': {
                const state = states.get(ws);
                if (!state || state.id !== message.requestId) return;
                if (state.retries >= 3) return fail(ws);
                return request(ws, state.id, state.retries + 1);
            }
        }
    }
    return { request, summary, handle, active: ws => states.has(ws),
        cancel: (ws, id) => { if (states.get(ws)?.id === id) clear(ws); } };
}

module.exports = { createChainSync, locator };
