const { Transaction, publicKeyToAddress, verifyWithECDSA } = require('../core');
const { hash, toUnits } = require('../protocol');

const FIELDS = ['version', 'chainId', 'kind', 'id', 'from', 'to', 'amount', 'fee', 'note',
    'currency', 'nonce', 'timestamp', 'publicKey', 'signature', 'evmAddress', 'rawTransaction', 'blockHeight'];

class EvmTransaction extends Transaction {
    constructor({ chainId, kind, from, to, amount = '0', fee = '0', nonce, evmAddress = '', rawTransaction = '' }) {
        super(from, to, amount, fee, '', 'STC', nonce, { version: 2, chainId });
        this.version = 3;
        this.kind = kind;
        this.evmAddress = evmAddress;
        this.rawTransaction = rawTransaction;
        this.id = this.calculateHash();
    }

    calculateHash() {
        if (this.version !== 3) return super.calculateHash();
        return hash(JSON.stringify(['StarCoin/evm-envelope', 3, this.chainId, this.kind, this.from, this.to,
            toUnits(this.amount).toString(), toUnits(this.fee).toString(), this.nonce, this.timestamp,
            this.evmAddress, this.rawTransaction]));
    }

    signTransaction(privateKey, publicKey) {
        this.id = this.calculateHash();
        super.signTransaction(privateKey, publicKey);
    }

    isValid() {
        try {
            return this.id === this.calculateHash() && publicKeyToAddress(this.publicKey) === this.from
                && verifyWithECDSA(this.id, this.signature, this.publicKey);
        } catch { return false; }
    }

    static fromJSON(data) {
        const tx = Object.create(EvmTransaction.prototype);
        for (const field of FIELDS) if (Object.hasOwn(data, field)) tx[field] = data[field];
        return tx;
    }
}

module.exports = { EvmTransaction };
