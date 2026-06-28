const crypto = require('crypto');

// ============================================================
// ECDSA 工具函数 - 使用 secp256k1 椭圆曲线
// ============================================================
const EC_CURVE = 'secp256k1';

function getPublicKeyFromPrivateKeyPem(privateKeyPem) {
    const key = crypto.createPrivateKey({ key: privateKeyPem, format: 'pem', type: 'pkcs8' });
    return crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('hex');
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
// 支持的币种常量（与 config.js 保持一致；此处独立副本便于核心模块不依赖 config）
// ============================================================
const SUPPORTED_CURRENCIES = ['STC', 'cBTC', 'cETH'];
const DEFAULT_CURRENCY = 'STC';

// 旧币种名 → 新币种名 迁移映射（兼容旧链数据）
const CURRENCY_MIGRATION_MAP = {
    'WBTC': 'cBTC',
    'WETH': 'cETH'
};

/**
 * 规整币种符号：空/非法 → 返回 undefined（表示"旧格式、无币种字段"），
 * 合法值 → 返回大写符号。
 * 关键设计：undefined 表示"该交易使用旧格式"，在 hash 计算中不引入 currency 字段，
 * 从而保证已签名的旧链交易 hash/签名仍然有效。
 */
function normalizeCurrency(raw) {
    if (!raw || typeof raw !== 'string') return undefined;
    const up = raw.trim().toUpperCase();
    // 1. 检查旧币种迁移映射（兼容旧链数据）
    if (CURRENCY_MIGRATION_MAP[up]) return CURRENCY_MIGRATION_MAP[up];
    // 2. 大小写不敏感匹配当前支持的币种，返回标准格式
    const match = SUPPORTED_CURRENCIES.find(c => c.toUpperCase() === up);
    return match || undefined;
}

/**
 * 获取交易的有效币种（用于余额/显示逻辑）：
 * currency 为 undefined 时视为 'STC'，用于余额计算/UI 显示。
 */
function effectiveCurrency(txOrCurrency) {
    if (txOrCurrency && typeof txOrCurrency === 'object') {
        const c = txOrCurrency.currency;
        // currency 已经是 normalizeCurrency 处理过的标准格式，直接判断
        if (c && SUPPORTED_CURRENCIES.includes(c)) return c;
        // 回退：检查旧币种迁移映射
        if (c) {
            const up = c.toUpperCase();
            if (CURRENCY_MIGRATION_MAP[up]) return CURRENCY_MIGRATION_MAP[up];
            const match = SUPPORTED_CURRENCIES.find(s => s.toUpperCase() === up);
            if (match) return match;
        }
        return DEFAULT_CURRENCY;
    }
    if (!txOrCurrency || typeof txOrCurrency !== 'string') return DEFAULT_CURRENCY;
    const up = txOrCurrency.trim().toUpperCase();
    if (CURRENCY_MIGRATION_MAP[up]) return CURRENCY_MIGRATION_MAP[up];
    const match = SUPPORTED_CURRENCIES.find(c => c.toUpperCase() === up);
    return match || DEFAULT_CURRENCY;
}

// ============================================================
// Transaction 类 - 结构化交易对象（带 ECDSA 签名 + 多币种）
// 兼容策略：currency === undefined  → 旧格式交易（hash 公式与上线前完全一致）
//          currency === 'STC'/'cBTC'/'cETH' → 新格式多币种交易
// ============================================================
class Transaction {
    constructor(from, to, amount, fee = 0, note = '', currency) {
        this.currency = normalizeCurrency(currency);
        // id：旧格式（无 currency）不引入 currency；新格式引入 currency 参与 id hash
        const idInput = from + to + amount + fee + note +
            (this.currency || '') + Date.now() + Math.random();
        this.id = crypto.createHash('sha256').update(idInput).digest('hex');
        this.from = from;
        this.to = to;
        this.amount = Number(amount);
        this.fee = Number(fee) || 0;
        this.note = note || '';
        this.timestamp = new Date().toISOString();
        this.publicKey = '';
        this.signature = '';
    }

    /**
     * 计算 hash：
     * - 若 this.currency 为 undefined（旧格式交易）：hash 公式与旧代码完全一致，
     *   保证已签名交易的签名仍然有效。
     * - 若 this.currency 有值：引入 currency 参与 hash，防止"币种伪造"。
     */
    calculateHash() {
        if (!this.currency) {
            // 旧格式：完全兼容旧链（已持久化的区块、已签名的交易 hash 不变）
            return crypto.createHash('sha256').update(
                this.id + this.from + this.to + this.amount +
                this.fee + this.note + this.timestamp
            ).digest('hex');
        }
        // 新格式：引入 currency 参与 hash
        return crypto.createHash('sha256').update(
            this.id + this.from + this.to + this.amount +
            this.fee + this.note + this.currency + this.timestamp
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

/**
 * 从已有的私钥 PEM 导入钱包，推导出公钥和地址
 * @param {string} privateKeyPem - PKCS#8 PEM 格式的私钥
 * @returns {{ privateKey: string, publicKey: string, address: string }}
 */
function importWalletFromPrivateKey(privateKeyPem) {
    const publicKey = getPublicKeyFromPrivateKeyPem(privateKeyPem);
    const address = publicKeyToAddress(publicKey);
    return { privateKey: privateKeyPem, publicKey, address };
}

// ============================================================
// Merkle 树：计算交易列表的 Merkle 根
// ============================================================
function calculateMerkleRoot(transactions) {
    if (!transactions || transactions.length === 0) {
        return crypto.createHash('sha256').update('').digest('hex');
    }

    // 第一层：每笔交易算自己的哈希
    // 注意：从其他节点或文件加载的 tx 可能是普通 JSON 对象（非 Transaction 实例），
    // 此时 tx.calculateHash 不存在，需要直接计算 hash
    let layer = transactions.map(tx => {
        if (typeof tx.calculateHash === 'function') {
            return tx.calculateHash();
        }
        // 普通 JSON 对象：直接用字段计算 hash
        return crypto.createHash('sha256').update(
            (tx.id || '') + (tx.from || '') + (tx.to || '') + (Number(tx.amount) || 0) +
            (Number(tx.fee) || 0) + (tx.note || '') + (tx.timestamp || '')
        ).digest('hex');
    });

    // 逐层向上合并，直到只剩一个根
    while (layer.length > 1) {
        // 如果奇数个，复制最后一个凑成偶数
        if (layer.length % 2 !== 0) {
            layer.push(layer[layer.length - 1]);
        }

        const newLayer = [];
        for (let i = 0; i < layer.length; i += 2) {
            newLayer.push(
                crypto.createHash('sha256')
                    .update(layer[i] + layer[i + 1])
                    .digest('hex')
            );
        }
        layer = newLayer;
    }

    return layer[0];
}

// ============================================================
// Block 类 - 现在包含 transactions 数组 和 Merkle 根
// ============================================================
class Block {
    constructor(index, timestamp, dataOrTransactions, previousHash = '') {
        this.index = index;
        this.timestamp = timestamp;
        this.previousHash = previousHash;
        this.nonce = 0;
        this.merkleRoot = null;  // 默认为 null，兼容旧区块

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

        // 设置完交易后计算 Merkle 根
        this.updateMerkleRoot();
        this.hash = this.calculateHash();
    }

    // 计算并更新 Merkle 根
    updateMerkleRoot() {
        this.merkleRoot = calculateMerkleRoot(this.transactions);
    }

    calculateHash() {
        let dataForHash;
        if (this.merkleRoot) {
            // 新区块：使用 Merkle 根作为数据指纹
            dataForHash = this.merkleRoot;
        } else {
            // 兼容旧区块（没有 merkleRoot 字段）：直接序列化交易数组
            dataForHash = JSON.stringify(this.transactions || []);
        }
        return crypto.createHash('sha256').update(
            String(this.index) + String(this.previousHash) +
            String(this.timestamp) + dataForHash + String(this.nonce)
        ).digest('hex');
    }

    // 静态：根据难度值生成 {prefixLength, maxNextByte, targetText}
    //   整数部分 = 前导零位数
    //   小数部分 = 对"前导零后第一字节"的上限约束（0x00 ~ 0xff 映射到 0.00~1.00）
    //   例：difficulty = 5.5  →  要求哈希以 "00000" 开头，且下一个 hex 值 ≤ 0x7f
    static _parseDifficulty(difficulty) {
        const d = Math.max(0, Number(difficulty) || 0);
        const prefixLength = Math.floor(d);            // 前导零位数（整数部分）
        const fraction = d - prefixLength;             // 小数部分，0.00 ~ 0.999...
        // 小数部分约束下一个 hex 字节的上限（00~ff 共 256 个值，映射 fraction*256）
        // fraction=0 → 不额外约束（相当于只看前缀零）
        // fraction=1 → 等价于 prefixLength+1（下一个字节必须是 0x00，即多一位零）
        const maxNextByte = fraction > 0
            ? Math.max(0, Math.min(255, Math.floor(fraction * 256))) // 上限（不含）
            : null;
        const targetText = '0'.repeat(prefixLength) +
            (maxNextByte != null ? `(≤${maxNextByte.toString(16).padStart(2,'0')})` : '');
        return { prefixLength, maxNextByte, targetText };
    }

    // 静态：判断一个 hash 是否满足指定难度（供挖矿、验证共用）
    static _meetsDifficulty(hash, difficulty) {
        const { prefixLength, maxNextByte } = Block._parseDifficulty(difficulty);
        // 1) 前缀零检查
        if (hash.substring(0, prefixLength) !== '0'.repeat(prefixLength)) return false;
        // 2) 小数部分：检查前缀之后的下一个字节（2 位 hex）是否在约束内
        if (maxNextByte != null) {
            const nextByteHex = hash.substring(prefixLength, prefixLength + 2);
            if (nextByteHex.length < 2) return false;
            const nextByteVal = parseInt(nextByteHex, 16);
            // 注意：maxNextByte 是"上限（不含）"。fraction=1 → maxNextByte=256 时
            // 实际上被上面 clamp 成 255，效果等价于"再加一位零"的近似。
            if (nextByteVal >= maxNextByte) return false;
        }
        return true;
    }

    // 同步挖矿（用于测试）
    mineBlock(difficulty) {
        const { targetText } = Block._parseDifficulty(difficulty);
        this.targetText = targetText;
        while (!Block._meetsDifficulty(this.hash, difficulty)) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
    }

    // 异步挖矿（带进度回调，用于前端动画）
    // 每 stepInterval 次 hash 让步一次事件循环 + 回调进度
    // @param {function} [shouldAbort] - 可选函数，每次让步时调用，返回 true 则中止挖矿
    async mineBlockAsync(difficulty, onProgress, stepInterval = 5000, shouldAbort) {
        const { targetText } = Block._parseDifficulty(difficulty);
        this.targetText = targetText;
        while (!Block._meetsDifficulty(this.hash, difficulty)) {
            // 检查是否需要中止（例如外部链已更新）
            if (shouldAbort && shouldAbort()) {
                if (onProgress) {
                    onProgress({
                        nonce: this.nonce,
                        hash: this.hash,
                        target: targetText,
                        difficulty: difficulty,
                        found: false,
                        aborted: true,
                        reason: 'chain_updated'
                    });
                }
                return { aborted: true, reason: 'chain_updated' };
            }

            this.nonce++;
            this.hash = this.calculateHash();

            if (this.nonce % stepInterval === 0) {
                // 让步事件循环，让 SSE 等异步操作有机会发送数据
                await new Promise(r => setImmediate(r));
                if (onProgress) {
                    onProgress({
                        nonce: this.nonce,
                        hash: this.hash,
                        target: targetText,
                        difficulty: difficulty,
                        found: false
                    });
                }
            }
        }
        // 挖到后回调一次
        if (onProgress) {
            onProgress({
                nonce: this.nonce,
                hash: this.hash,
                target: targetText,
                difficulty: difficulty,
                found: true
            });
        }
        return this;
    }
}

// ============================================================
// 导入工具：从 PEM 私钥恢复钱包
// ============================================================
function importWalletFromPem(privateKeyPem) {
    // 1) 基本格式校验
    if (!privateKeyPem || typeof privateKeyPem !== 'string') {
        throw new Error('私钥不能为空');
    }
    const trimmed = privateKeyPem.trim();
    if (!trimmed.startsWith('-----BEGIN')) {
        throw new Error('无效的 PEM 格式：必须以 -----BEGIN 开头');
    }
    // 2) 尝试解析私钥，如果失败说明密钥无效
    const publicKeyHex = getPublicKeyFromPrivateKeyPem(trimmed);
    const address = publicKeyToAddress(publicKeyHex);
    return { privateKey: privateKeyPem, publicKey: publicKeyHex, address };
}

module.exports = { Block, Transaction, generateWallet, calculateMerkleRoot,
                   getPublicKeyFromPrivateKeyPem, publicKeyToAddress,
                   verifyPublicKeyMatchesAddress, signWithECDSA, verifyWithECDSA,
                   importWalletFromPem,
                   SUPPORTED_CURRENCIES, DEFAULT_CURRENCY,
                   normalizeCurrency, effectiveCurrency };