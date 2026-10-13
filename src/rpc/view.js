const { keccak256 } = require('ethers');
const { EvmEngine } = require('../evm/engine');
const { q, integer, hash32, RpcError } = require('./codec');
const ZERO_BLOOM = '0x' + '00'.repeat(256), EMPTY_ROOT = keccak256('0x80');
function bloom(logs) {
    const bytes = Buffer.alloc(256);
    for (const log of logs) for (const item of [log.address, ...log.topics]) {
        const digest = Buffer.from(keccak256(item).slice(2), 'hex');
        for (let i = 0; i < 6; i += 2) { const bit = digest.readUInt16BE(i) & 2047; bytes[255 - (bit >> 3)] |= 1 << (bit & 7); }
    }
    return '0x' + bytes.toString('hex');
}
class RpcView {
    constructor(chain) { this.chain = chain; this.cache = new Map(); }
    height(tag = 'latest') {
        const head = this.chain.chain.length - 1;
        if (tag === 'latest' || tag === 'pending') return head;
        if (tag === 'earliest') return 0;
        return integer(tag, 'block number');
    }
    blockFor(tag = 'latest') {
        if (tag && typeof tag === 'object' && !Array.isArray(tag)) {
            if (tag.blockHash !== undefined && tag.blockNumber === undefined) {
                if (tag.requireCanonical !== undefined && typeof tag.requireCanonical !== 'boolean') throw new RpcError(-32602, 'requireCanonical 无效');
                return this.chain.chain.find(block => '0x' + block.hash === hash32(tag.blockHash));
            }
            if (tag.blockNumber !== undefined && tag.blockHash === undefined) return this.blockFor(tag.blockNumber);
            throw new RpcError(-32602, '无效区块选择器');
        }
        return this.chain.chain[this.height(tag)];
    }
    async stateAt(tag = 'latest') {
        if (tag === 'pending') return this.chain.pendingEvaluation();
        const block = this.blockFor(tag);
        if (!block) throw new RpcError(-32000, '区块不存在或不在主链');
        let result;
        if (block === this.chain.getLatestBlock()) result = this.chain._evaluation;
        else if (this.cache.has(block.hash)) result = this.cache.get(block.hash);
        else {
            const blocks = this.chain.chain.slice(0, block.index + 1);
            if (block.index < this.chain.consensus.evm.activationHeight) result = {
                valid: true, blocks, state: { bridgeNonces: new Map() }, engine: await EvmEngine.create(this.chain.consensus.evm, blocks.slice(0, -1)) };
            else result = await this.chain.consensus.evaluateAsync(blocks);
            if (!result.valid) throw new RpcError(-32603, '历史状态重放失败');
            this.cache.set(block.hash, result); if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
        }
        return { ...result, context: { index: block.index, previousHash: block.previousHash, timestamp: block.timestamp, baseFeePerGas: block.baseFeePerGas ?? '0' } };
    }
    records(transactions) { return transactions.filter(tx => tx.rawTransaction && ['evm', 'evmRaw'].includes(tx.kind)); }
    tx(tx, block = null, index = null) {
        const raw = this.chain._evaluation.engine.decode(tx.rawTransaction, true), json = raw.toJSON();
        const base = BigInt(block?.baseFeePerGas ?? this.chain.consensus.context(this.chain.chain).baseFeePerGas);
        const price = raw.type === 2 ? (raw.maxFeePerGas < base + raw.maxPriorityFeePerGas ? raw.maxFeePerGas : base + raw.maxPriorityFeePerGas) : raw.gasPrice;
        return { hash: keccak256(tx.rawTransaction), nonce: q(raw.nonce), from: raw.getSenderAddress().toString(), to: raw.to?.toString() || null,
            value: q(raw.value), gas: q(raw.gasLimit), gasPrice: q(price), input: '0x' + Buffer.from(raw.data).toString('hex'), type: q(raw.type),
            chainId: q(this.chain.consensus.evm.chainId), blockHash: block ? '0x' + block.hash : null, blockNumber: block ? q(block.index) : null,
            transactionIndex: block ? q(index) : null, v: q(raw.v), r: '0x' + raw.r.toString(16).padStart(64, '0'), s: '0x' + raw.s.toString(16).padStart(64, '0'),
            ...(raw.type ? { accessList: json.accessList } : {}), ...(raw.type === 2 ? { maxFeePerGas: q(raw.maxFeePerGas), maxPriorityFeePerGas: q(raw.maxPriorityFeePerGas), yParity: q(raw.v) } : {}) };
    }
    find(hash) {
        hash = hash32(hash);
        for (const block of this.chain.chain) {
            const records = this.records(block.transactions);
            const index = records.findIndex(tx => keccak256(tx.rawTransaction) === hash);
            if (index >= 0) return { tx: records[index], block, index };
        }
        const tx = this.records(this.chain.pendingTransactions).find(tx => keccak256(tx.rawTransaction) === hash);
        return tx ? { tx, block: null, index: null } : null;
    }
    blockLogs(block) {
        const result = [], transactions = this.records(block.transactions);
        for (let index = 0; index < transactions.length; index++) {
            const receipt = this.chain._evaluation.receipts.get(transactions[index].id);
            for (const log of receipt?.logs || []) result.push({ address: log.address, topics: log.topics, data: log.data,
                blockNumber: q(block.index), blockHash: '0x' + block.hash, transactionHash: receipt.transactionHash,
                transactionIndex: q(index), logIndex: q(result.length), removed: false });
        }
        return result;
    }
    receipt(hash) {
        const found = this.find(hash); if (!found?.block) return null;
        const { tx, block, index } = found, receipt = this.chain._evaluation.receipts.get(tx.id), transactions = this.records(block.transactions);
        const cumulative = transactions.slice(0, index + 1).reduce((sum, item) => sum + BigInt(this.chain._evaluation.receipts.get(item.id).gasUsed), 0n);
        const logs = this.blockLogs(block).filter(log => log.transactionHash === hash.toLowerCase());
        return { transactionHash: receipt.transactionHash, transactionIndex: q(index), blockHash: '0x' + block.hash,
            blockNumber: q(block.index), from: receipt.from, to: receipt.to, contractAddress: receipt.contractAddress,
            status: q(receipt.status), gasUsed: q(receipt.gasUsed), cumulativeGasUsed: q(cumulative),
            effectiveGasPrice: q(receipt.gasPriceWei), type: q(this.chain._evaluation.engine.decode(tx.rawTransaction, true).type), logs, logsBloom: bloom(logs) };
    }
    async block(tag, full = false) {
        if (typeof full !== 'boolean') throw new RpcError(-32602, 'fullTransactions 必须为 boolean');
        const pending = tag === 'pending', actual = this.blockFor(tag); if (!actual) return null;
        const context = this.chain.consensus.context(this.chain.chain);
        const block = pending ? { ...actual, ...context, evmStateRoot: await (await this.chain.pendingEvaluation()).engine.root(),
            previousHash: actual.hash, evmGasUsed: '0', receiptsRoot: null } : actual;
        const records = this.records(pending ? this.chain.pendingTransactions : actual.transactions);
        return { number: pending ? null : q(block.index), hash: pending ? null : '0x' + block.hash, parentHash: '0x' + block.previousHash.padStart(64, '0'),
            nonce: pending ? null : '0x' + BigInt(block.nonce).toString(16).padStart(16, '0'), sha3Uncles: keccak256('0xc0'),
            logsBloom: pending ? ZERO_BLOOM : bloom(this.blockLogs(actual)), transactionsRoot: '0x' + (block.merkleRoot || '0'.repeat(64)),
            stateRoot: block.evmStateRoot || EMPTY_ROOT, receiptsRoot: block.receiptsRoot ? '0x' + block.receiptsRoot : EMPTY_ROOT,
            miner: '0x000000000000000000000000000000000000dead', difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x',
            size: q(Buffer.byteLength(JSON.stringify(block))), gasLimit: q(this.chain.consensus.evm.blockGasLimit), gasUsed: q(block.evmGasUsed || '0'),
            timestamp: q(Math.floor(Date.parse(block.timestamp) / 1000)), mixHash: '0x' + block.previousHash.padStart(64, '0'),
            baseFeePerGas: q(block.baseFeePerGas || '0'), transactions: records.map((tx, index) => full ? this.tx(tx, pending ? null : actual, index) : keccak256(tx.rawTransaction)), uncles: [] };
    }
}
module.exports = { RpcView, bloom };
