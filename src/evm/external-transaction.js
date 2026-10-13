const { TypedDataEncoder, verifyTypedData } = require('ethers');
const { hash } = require('../protocol');
const { address, hex, uint } = require('./engine');

const FIELDS = ['version', 'chainId', 'kind', 'id', 'from', 'to', 'amount', 'fee', 'note', 'currency', 'nonce',
    'timestamp', 'publicKey', 'signature', 'evmAddress', 'rawTransaction', 'amountUnits', 'deadline', 'blockHeight'];
const FIXED_TIME = '1970-01-01T00:00:00.000Z';
const WITHDRAW_TYPES = { Withdraw: [ { name: 'owner', type: 'address' }, { name: 'nativeAddress', type: 'bytes16' },
    { name: 'amountUnits', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' } ] };

function withdrawalData(consensus, owner, nativeAddress, amountUnits, nonce, deadline) {
    if (!/^[0-9a-f]{32}$/.test(nativeAddress)) throw new Error('原生收款地址必须为 16 字节十六进制地址');
    return { domain: { name: 'StarCoin Bridge', version: '1', chainId: consensus.evm.chainId, salt: '0x' + consensus.rpcFingerprint },
        types: WITHDRAW_TYPES, primaryType: 'Withdraw', message: { owner: address(owner), nativeAddress: '0x' + nativeAddress,
            amountUnits: uint(amountUnits).toString(), nonce: uint(nonce).toString(), deadline: uint(deadline).toString() } };
}

class ExternalTransaction {
    constructor(chainId, kind, from, to, nonce) {
        Object.assign(this, { version: 4, chainId, kind, from, to, nonce: uint(nonce).toString(), amount: '0', fee: '0',
            currency: 'STC', note: '', timestamp: FIXED_TIME, publicKey: '', signature: '', evmAddress: from, rawTransaction: '' });
    }
    static raw(chainId, engine, raw) {
        raw = hex(raw); const decoded = engine.decode(raw, true);
        const tx = new ExternalTransaction(chainId, 'evmRaw', decoded.getSenderAddress().toString(), decoded.to?.toString() || 'EVM_CREATE', decoded.nonce);
        tx.rawTransaction = raw; tx.id = tx.calculateHash(); return tx;
    }
    static withdraw(consensus, message, signature) {
        const data = withdrawalData(consensus, message.owner, message.nativeAddress.replace(/^0x/, ''), message.amountUnits, message.nonce, message.deadline);
        const owner = address(verifyTypedData(data.domain, data.types, data.message, signature));
        if (owner !== data.message.owner) throw new Error('取回签名与账户不匹配');
        const tx = new ExternalTransaction(consensus.params.chainId, 'evmWithdraw', owner, data.message.nativeAddress.slice(2), data.message.nonce);
        tx.amountUnits = data.message.amountUnits; tx.deadline = data.message.deadline; tx.signature = hex(signature, 65);
        if (tx.signature.length !== 132) throw new Error('取回签名必须为 65 字节');
        tx.id = tx.calculateHash(); return tx;
    }
    calculateHash() {
        return hash(JSON.stringify(['StarCoin/external', 4, this.chainId, this.kind, this.from, this.to, this.nonce,
            this.rawTransaction, this.amountUnits ?? null, this.deadline ?? null, this.signature]));
    }
    isValid() { try { return this.id === this.calculateHash(); } catch { return false; } }
    static fromJSON(data) {
        const tx = Object.create(ExternalTransaction.prototype);
        for (const field of FIELDS) if (Object.hasOwn(data, field)) tx[field] = data[field];
        return tx;
    }
    assertCanonical(expected) {
        if (FIELDS.some(field => this[field] !== expected[field])) throw new Error('外部交易封装与签名内容不匹配');
    }
}
module.exports = { ExternalTransaction, withdrawalData, WITHDRAW_TYPES, TypedDataEncoder };
