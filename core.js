const crypto = require('crypto');

// ============================================================
// ECDSA 工具函数 - 使用 secp256k1 椭圆曲线
// ============================================================
const EC_CURVE = 'secp256k1';

function getPublicKeyFromPrivateKeyPem(privateKeyPem) {
    const key = crypto.createPrivateKey({ key: privateKeyPem, format: 'pem', type: 'pkcs8' });
    return key.export({ format: 'der', type: 'spki' }).toString('hex');
}

function publicKeyToAddress(publicKeyHex) {
    return crypto.createHash('sha256').update(publicKeyHex, 'hex').digest('hex').substring(0, 32);
}

function verifyPublicKeyMatchesAddress(publicKeyHex, address) {
    return publicKeyToAddress(publicKeyHex) === address;
}

function signWithECDSA(dataHex, privateKeyPem) {
    const sign = crypto.createSign('SHA256');
    sign.update(dataHex);
    return sign.sign({ key: privateKeyPem, format: 'pem', type: 'pkcs8' }, 'hex');
}

function verifyWithECDSA(dataHex, signatureHex, publicKeyHex) {
    try {
        const publicKeyPem = crypto.createPublicKey({
            key: Buffer.from(publicKeyHex, 'hex'),
            format: 'der',
            type: 'spki'
        }).export({ format: 'pem', type: 'spki' });

        const verify = crypto.createVerify('SHA256');
        verify.update(dataHex);
        return verify.verify(publicKeyPem, signatureHex, 'hex');
    } catch (err) {
        return false;
    }
}

// ============================================================
// Transaction 类 - 结构化交易对象（带 ECDSA 签名）
// ============================================================
class Transaction {
    constructor(from, to, amount, fee = 0, note = '') {
        this.id = crypto.createHash('sha256').update(
            from + to + amount + fee + note + Date.now() + Math.random()
        ).digest('hex');
        this.from = from;
        this.to = to;
        this.amount = Number(amount);
        this.fee = Number(fee) || 0;
        this.note = note || '';
        this.timestamp = new Date().toISOString();
        this.publicKey = '';
        this.signature = '';
    }

    calculateHash() {
        return crypto.createHash('sha256').update(
            this.id + this.from + this.to + this.amount +
            this.fee + this.note + this.timestamp
        ).digest('hex');
    }

    signTransaction(privateKeyPem, publicKeyHex) {
        if (!this.from || this.from === '' || this.from === 'SYSTEM') {
            return;
        }

        if (!privateKeyPem || !publicKeyHex) {
            throw new Error('签名交易必须提供私钥和公钥');
        }

        if (!verifyPublicKeyMatchesAddress(publicKeyHex, this.from)) {
            throw new Error('公钥与 from 地址不匹配，无法签名');
        }

        const hash = this.calculateHash();
        this.publicKey = publicKeyHex;
        this.signature = signWithECDSA(hash, privateKeyPem);
    }

    isValid() {
        if (!this.from || this.from === '' || this.from === 'SYSTEM') {
            return this.amount >= 0;
        }

        if (!this.signature || this.signature.length === 0) {
            return false;
        }
        if (!this.publicKey || this.publicKey.length === 0) {
            return false;
        }

        if (!verifyPublicKeyMatchesAddress(this.publicKey, this.from)) {
            return false;
        }

        const hash = this.calculateHash();
        return verifyWithECDSA(hash, this.signature, this.publicKey);
    }
}

// ============================================================
// Wallet 工具 - 生成真正的 ECDSA 地址/密钥对
// ============================================================
function generateWallet() {
    const keyPair = crypto.generateKeyPairSync('ec', {
        namedCurve: EC_CURVE,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const privateKey = keyPair.privateKey;
    const publicKey = keyPair.publicKey.toString('hex');
    const address = publicKeyToAddress(publicKey);

    return { privateKey, publicKey, address };
}

// ============================================================
// Block 类 - 现在包含 transactions 数组
// ============================================================
class Block {
    constructor(index, timestamp, dataOrTransactions, previousHash = '') {
        this.index = index;
        this.timestamp = timestamp;
        this.previousHash = previousHash;
        this.nonce = 0;

        if (!Array.isArray(dataOrTransactions) && dataOrTransactions &&
            typeof dataOrTransactions === 'object' && dataOrTransactions.data &&
            !Array.isArray(dataOrTransactions.transactions)) {
            this.data = { data: dataOrTransactions.data };
            this.transactions = [new Transaction('', 'NOTE', 0, 0, dataOrTransactions.data)];
        }
        else if (dataOrTransactions && typeof dataOrTransactions === 'object' &&
                 Array.isArray(dataOrTransactions.transactions)) {
            this.transactions = dataOrTransactions.transactions;
            if (dataOrTransactions.data !== undefined) {
                this.data = dataOrTransactions.data;
            }
        }
        else if (Array.isArray(dataOrTransactions)) {
            this.transactions = dataOrTransactions;
        }
        else {
            this.transactions = [];
        }

        this.hash = this.calculateHash();
    }

    calculateHash() {
        let dataForHash;
        if (this.data !== undefined) {
            dataForHash = JSON.stringify(this.data);
        } else {
            dataForHash = JSON.stringify(this.transactions || []);
        }
        return crypto.createHash('sha256').update(
            String(this.index) + String(this.previousHash) +
            String(this.timestamp) + dataForHash + String(this.nonce)
        ).digest('hex');
    }

    mineBlock(difficulty) {
        const target = Array(difficulty + 1).join('0');
        while (this.hash.substring(0, difficulty) !== target) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
    }
}

module.exports = { Block, Transaction, generateWallet,
                   getPublicKeyFromPrivateKeyPem, publicKeyToAddress,
                   verifyPublicKeyMatchesAddress, signWithECDSA, verifyWithECDSA };