const config = require('./config');
const logger = require('./logger');

class MempoolError extends Error {
    constructor(code, message, statusCode = 429) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
    }
}

const messageBudget = () => Math.min(1024 * 1024, Math.floor(config.P2P_MAX_PAYLOAD * 0.75));
const transactionBytes = tx => Buffer.byteLength(JSON.stringify(tx), 'utf8');

// Reserve the complete page envelope, including a maximum-length peer URL and cursors.
function maxTransactionBytes() {
    return messageBudget() - Buffer.byteLength(JSON.stringify({ type: 'PENDING_TXS', transactions: [],
        fromNode: 'w'.repeat(512), poolId: '0'.repeat(64), cursor: Number.MAX_SAFE_INTEGER,
        next: Number.MAX_SAFE_INTEGER }), 'utf8');
}

class MempoolBudget {
    constructor(pending = []) {
        this.limits = { count: config.MEMPOOL_MAX_TXS, bytes: config.MEMPOOL_MAX_BYTES, sender: config.MEMPOOL_MAX_PER_ADDRESS };
        if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value < 1)
            || this.limits.bytes < 2 || maxTransactionBytes() < 1) throw new Error('无效交易池容量配置');
        this.count = 0;
        this.bytes = 2; // JSON array brackets; separators are included below.
        this.senders = new Map();
        for (const tx of pending) this.add(tx, transactionBytes(tx));
    }

    check(tx) {
        const size = transactionBytes(tx);
        if (size > maxTransactionBytes()) throw new MempoolError('TRANSACTION_TOO_LARGE', '交易超过 P2P 单条消息容量', 413);
        if (this.count >= this.limits.count) throw new MempoolError('MEMPOOL_FULL', '交易池笔数已达上限，请等待交易确认');
        if (this.bytes + size + (this.count ? 1 : 0) > this.limits.bytes)
            throw new MempoolError('MEMPOOL_BYTES_FULL', '交易池字节容量已达上限，请等待交易确认');
        if ((this.senders.get(tx.from) || 0) >= this.limits.sender)
            throw new MempoolError('MEMPOOL_SENDER_LIMIT', '该地址的待确认交易笔数已达上限');
        return size;
    }

    add(tx, size) {
        this.bytes += size + (this.count ? 1 : 0);
        this.count++;
        this.senders.set(tx.from, (this.senders.get(tx.from) || 0) + 1);
    }
}

function reportPoolRejections(rejected) {
    const counts = {};
    for (const entry of rejected) if (entry.code) counts[entry.code] = (counts[entry.code] || 0) + 1;
    if (Object.keys(counts).length) logger.module('Mempool').warn('交易池重建触发本地容量限制', counts);
}

module.exports = { MempoolError, MempoolBudget, messageBudget, reportPoolRejections };
