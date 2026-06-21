const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ============================================================
// Transaction 类 - 结构化交易对象
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
        this.signature = '';
    }

    calculateHash() {
        return crypto.createHash('sha256').update(
            this.id + this.from + this.to + this.amount +
            this.fee + this.note + this.timestamp
        ).digest('hex');
    }

    // 用私钥签名交易（简单演示，非真实椭圆曲线）
    signTransaction(privateKey) {
        if (!privateKey) return;
        const hash = this.calculateHash();
        this.signature = crypto
            .createHmac('sha256', privateKey)
            .update(hash)
            .digest('hex');
    }

    // 验证交易签名（用公钥/地址验证）
    isValid() {
        // 创世交易或挖矿奖励交易：from 为空，直接有效
        if (this.from === '' || this.from === 'SYSTEM' || !this.from) {
            return this.amount > 0;
        }
        // 普通交易：必须有签名
        return this.signature && this.signature.length > 0;
    }
}

// ============================================================
// Wallet 工具 - 生成简单的地址/密钥对
// ============================================================
function generateWallet() {
    const privateKey = crypto.randomBytes(32).toString('hex');
    const publicKey = crypto.createHash('sha256').update(privateKey).digest('hex');
    const address = publicKey.substring(0, 32);
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

        // ============== 智能数据处理：兼容新旧格式 ==============
        // 情况 A：传入的是旧格式对象 { data: "xxx" } (如从旧 blockchain.json 读取)
        if (!Array.isArray(dataOrTransactions) && dataOrTransactions &&
            typeof dataOrTransactions === 'object' && dataOrTransactions.data &&
            !Array.isArray(dataOrTransactions.transactions)) {
            // 保留原始 data —— 关键：用于 calculateHash，保持旧区块 hash 不变
            this.data = { data: dataOrTransactions.data };
            // 同时派生 transactions 数组用于显示/遍历
            this.transactions = [new Transaction('', 'NOTE', 0, 0, dataOrTransactions.data)];
        }
        // 情况 B：传入的是带 transactions 字段的对象 (如从新 JSON 反序列化)
        else if (dataOrTransactions && typeof dataOrTransactions === 'object' &&
                 Array.isArray(dataOrTransactions.transactions)) {
            this.transactions = dataOrTransactions.transactions;
            // 如果同时有 data 字段也保留（混合格式）
            if (dataOrTransactions.data !== undefined) {
                this.data = dataOrTransactions.data;
            }
        }
        // 情况 C：传入的是 transactions 数组（新格式，代码里新建区块时用）
        else if (Array.isArray(dataOrTransactions)) {
            this.transactions = dataOrTransactions;
        }
        // 情况 D：其他情况（空）
        else {
            this.transactions = [];
        }

        this.hash = this.calculateHash();
    }

    // 关键：hash 计算要保持向后兼容
    // 1) 如果区块有 this.data（旧格式） → 用 JSON.stringify(this.data) 计算 hash
    // 2) 如果区块只有 this.transactions（新格式） → 用 JSON.stringify(this.transactions) 计算 hash
    calculateHash() {
        let dataForHash;
        if (this.data !== undefined) {
            // 旧格式：保留原始 data 用于 hash 计算，保证与旧区块的 hash 一致
            dataForHash = JSON.stringify(this.data);
        } else {
            // 新格式：用 transactions 计算 hash
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

class Blockchain {
    constructor(portOverride) {
        const PORT = process.env.PORT || 3000;
        this.difficulty = 2;
        this.pendingTransactions = [];  // 交易池 (Mempool)
        this.miningReward = 50;          // 挖矿奖励
        this.miningAddress = 'MINER_' + (portOverride || PORT);
        this.chain = [this.createGenesisBlock()]; // 先初始化创世区块
        this.dataFile = path.join(__dirname, 'data', `blockchain_${portOverride || PORT}.json`);
        this.loadFromFile();
    }

    createGenesisBlock() {
        // 关键：创世区块必须使用旧格式 { data: '创世区块...' }
        // 这样旧节点、新节点、旧 blockchain.json 文件的创世区块 hash 完全一致
        // Block 构造函数会自动派生 transactions 数组用于显示/遍历
        return new Block(0, '2025-01-01T00:00:00.000Z',
            { data: '创世区块：StarCoin诞生！' }, '0');
    }

    // 添加交易到交易池
    addTransaction(tx) {
        // 校验基本字段
        if (!tx.from || !tx.to || tx.amount <= 0) {
            throw new Error('交易必须包含 from, to, 和正数 amount');
        }
        if (tx.from === tx.to) {
            throw new Error('不能给自己转账');
        }
        // 检查余额
        const senderBalance = this.getBalance(tx.from);
        if (senderBalance < tx.amount + tx.fee) {
            throw new Error(`余额不足！当前余额: ${senderBalance}, 转账所需: ${tx.amount + tx.fee}`);
        }
        // 签名验证（简单演示：如果有签名则认为合法）
        // if (!tx.signature) throw new Error('交易未签名');

        // 生成交易对象（如果传入的是普通对象）
        const transaction = (tx instanceof Transaction) ? tx :
            new Transaction(tx.from, tx.to, tx.amount, tx.fee || 0, tx.note || '');

        this.pendingTransactions.push(transaction);
        return transaction;
    }

    // 从交易池挖矿，打包交易到新区块
    mineBlock(minerAddress, blockDataText) {
        // 准备要打包的交易
        const txsToInclude = this.pendingTransactions.slice(0, 100); // 最多100笔/区块
        // 如果没有交易，也允许只写一条备注文本（兼容旧接口）
        if (blockDataText && blockDataText.trim()) {
            txsToInclude.push(new Transaction('', 'NOTE', 0, 0, blockDataText.trim()));
        }
        if (txsToInclude.length === 0) {
            throw new Error('没有可打包的交易，请先发起一笔转账');
        }
        // 添加挖矿奖励交易（系统发给矿工）
        const rewardTx = new Transaction(
            'SYSTEM',
            minerAddress || this.miningAddress,
            this.miningReward,
            0,
            'Miner Reward'
        );
        txsToInclude.unshift(rewardTx);  // 奖励交易放在区块第一笔

        // 构建新区块
        const block = new Block(
            this.chain.length,
            new Date().toISOString(),
            txsToInclude,
            this.getLatestBlock().hash
        );
        block.mineBlock(this.difficulty);

        // 打包后清空这些交易
        const txIdsInBlock = txsToInclude.map(t => t.id);
        this.pendingTransactions = this.pendingTransactions.filter(t => !txIdsInBlock.includes(t.id));

        this.chain.push(block);
        this.saveToFile();
        return block;
    }

    // 计算指定地址的余额（遍历整个链）
    getBalance(address) {
        if (!address) return 0;
        let balance = 0;
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.from === address) {
                    balance -= tx.amount;
                    balance -= tx.fee;
                }
                if (tx.to === address) {
                    balance += tx.amount;
                }
            }
        }
        return balance;
    }

    // 获取地址的所有交易历史
    getTransactionHistory(address) {
        if (!address) return [];
        const history = [];
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.from === address || tx.to === address) {
                    history.push({
                        ...tx,
                        blockIndex: block.index,
                        blockHash: block.hash,
                        direction: tx.from === address ? 'OUT' : 'IN'
                    });
                }
            }
        }
        return history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    // 获取所有地址及其余额（用于排名展示）
    getAllAddresses() {
        const map = new Map();
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.from) map.set(tx.from, (map.get(tx.from) || 0));
                if (tx.to) map.set(tx.to, (map.get(tx.to) || 0));
            }
        }
        const result = [];
        for (const addr of map.keys()) {
            result.push({
                address: addr,
                balance: this.getBalance(addr),
                txCount: this.getTransactionHistory(addr).length
            });
        }
        return result.sort((a, b) => b.balance - a.balance);
    }

    loadFromFile() {
        try {
            if (fs.existsSync(this.dataFile)) {
                const raw = fs.readFileSync(this.dataFile, 'utf8');
                const saved = JSON.parse(raw);
                if (saved && saved.chain && saved.chain.length > 0) {
                    // 从保存数据重建区块对象 (支持 data 旧格式和 transactions 新格式)
                    const rebuiltChain = saved.chain.map(b => {
                        const txSource = b.transactions || (b.data ? b.data : []);
                        const block = new Block(b.index, b.timestamp, txSource, b.previousHash);
                        block.nonce = b.nonce;
                        block.hash = b.hash;
                        return block;
                    });
                    // 验证重建后的链是否有效（使用自身链进行哈希验证）
                    const tempChain = this.chain;
                    this.chain = rebuiltChain;
                    if (this.isChainValid()) {
                        console.log(`📂 已从本地文件加载区块链: ${this.dataFile} (${rebuiltChain.length} 个区块)`);
                        return true;
                    } else {
                        console.log('⚠️  本地文件中的区块链无效，恢复为创世区块');
                        this.chain = tempChain;
                        return false;
                    }
                } else {
                    console.log('⚠️  本地文件格式无效，已重置为创世区块');
                    return false;
                }
            } else {
                console.log(`📂 未找到本地文件，创建新链: ${this.dataFile}`);
                return false;
            }
        } catch (err) {
            console.error('❌ 从文件加载失败:', err.message);
            this.chain = [this.createGenesisBlock()];
            return false;
        }
    }

    saveToFile() {
        try {
            const data = {
                chain: this.chain,
                savedAt: new Date().toISOString(),
                version: '1.0'
            };
            fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2), 'utf8');
            return true;
        } catch (err) {
            console.error('❌ 保存到文件失败:', err.message);
            return false;
        }
    }

    clearDataFile() {
        try {
            if (fs.existsSync(this.dataFile)) {
                fs.unlinkSync(this.dataFile);
            }
            this.chain = [this.createGenesisBlock()];
            return true;
        } catch (err) {
            console.error('❌ 清除文件失败:', err.message);
            return false;
        }
    }

    getLatestBlock() {
        return this.chain[this.chain.length - 1];
    }

    addBlock(newBlock) {
        let block = newBlock;
        if (!(newBlock instanceof Block)) {
            const txSource = newBlock.transactions || (newBlock.data ? newBlock.data : []);
            block = new Block(newBlock.index, newBlock.timestamp, txSource, newBlock.previousHash);
            block.nonce = newBlock.nonce;
            block.hash = newBlock.hash;
        }
        if (block.hash !== block.calculateHash()) {
            return null;
        }
        this.chain.push(block);
        this.saveToFile();
        return block;
    }

    isChainValid(chain) {
        const targetChain = chain || this.chain;

        if (!targetChain || targetChain.length === 0) {
            return false;
        }

        // 如果是验证外来链，确保其创世块 hash 与本地一致（不同的创世块 = 不同的链）
        if (chain) {
            const incomingGenesisHash = targetChain[0].hash;
            const localGenesisHash = this.chain[0].hash;
            if (incomingGenesisHash !== localGenesisHash) {
                console.error(`❌ [isChainValid] 创世块 hash 不一致: 收到=${incomingGenesisHash}, 本地=${localGenesisHash}`);
                return false;
            }
        }

        for (let i = 1; i < targetChain.length; i++) {
            let currentBlock = targetChain[i];
            let previousBlock = targetChain[i - 1];

            if (!(currentBlock instanceof Block)) {
                const b = currentBlock;
                const txSrc = b.transactions || (b.data ? b.data : []);
                currentBlock = new Block(b.index, b.timestamp, txSrc, b.previousHash);
                currentBlock.nonce = b.nonce;
                currentBlock.hash = b.hash;
            }
            if (!(previousBlock instanceof Block)) {
                const b = previousBlock;
                const txSrc = b.transactions || (b.data ? b.data : []);
                previousBlock = new Block(b.index, b.timestamp, txSrc, b.previousHash);
                previousBlock.nonce = b.nonce;
                previousBlock.hash = b.hash;
            }

            const computedHash = currentBlock.calculateHash();
            if (currentBlock.hash !== computedHash) {
                if (chain) {
                    console.error(`❌ [isChainValid] 区块 #${currentBlock.index} hash 不一致: 原hash=${currentBlock.hash.substring(0, 16)}..., 计算hash=${computedHash.substring(0, 16)}...`);
                }
                return false;
            }

            if (currentBlock.previousHash !== previousBlock.hash) {
                if (chain) {
                    console.error(`❌ [isChainValid] 区块 #${currentBlock.index} 的 previousHash 与前一区块 hash 不匹配`);
                }
                return false;
            }
        }
        return true;
    }

    // 替换为更长的链
    replaceChain(newChain) {
        if (newChain.length <= this.chain.length) {
            console.log('⚠️  新链不更长，拒绝替换');
            return false;
        }
        if (!this.isChainValid(newChain)) {
            console.log('❌ 新链验证失败，拒绝替换');
            return false;
        }

        // ---------------------------------------------------------
        // 分叉回滚：将旧链中"不在新链里"的用户交易放回交易池
        // ---------------------------------------------------------
        // 1. 收集新链中所有交易 id（用于判断哪些交易已经被别人打包了）
        const txIdsInNewChain = new Set();
        for (const block of newChain) {
            if (block.transactions && Array.isArray(block.transactions)) {
                for (const tx of block.transactions) {
                    if (tx.id) txIdsInNewChain.add(tx.id);
                }
            }
        }

        // 2. 扫描旧链，收集"用户真实交易"回滚到交易池
        //    - 排除挖矿奖励交易（from === 'SYSTEM'）→ 不放回交易池（否则会重复发放奖励）
        //      但会统计金额，因为链被整体替换后这些奖励"已自动作废"（余额是动态计算的）
        //    - 排除备注/创世交易（from === '' 或 !from）→ 不是用户交易
        //    - 排除新链中已有的交易（即已被别人打包的）→ 无需重复放入
        //    - 排除当前 pendingTransactions 中已有的交易 → 防重复
        const existingPendingIds = new Set(this.pendingTransactions.map(t => t.id));
        const rollbackTx = [];

        // 用于日志确认：显式统计被回滚掉的矿工奖励总额
        let rollbackRewardCount = 0;
        let rollbackRewardAmount = 0;

        for (const block of this.chain) {
            if (!block.transactions || !Array.isArray(block.transactions)) continue;
            for (const tx of block.transactions) {
                // 挖矿奖励：统计但不放回交易池（链被替换后奖励自动作废）
                if (tx.from === 'SYSTEM') {
                    if (!txIdsInNewChain.has(tx.id)) {
                        rollbackRewardCount++;
                        rollbackRewardAmount += Number(tx.amount) || 0;
                    }
                    continue;
                }
                if (!tx.from || tx.from === '') continue;
                if (txIdsInNewChain.has(tx.id)) continue;
                if (existingPendingIds.has(tx.id)) continue;
                // 构造一个干净的 Transaction 对象放回交易池
                rollbackTx.push({
                    id: tx.id,
                    from: tx.from,
                    to: tx.to,
                    amount: Number(tx.amount),
                    fee: Number(tx.fee) || 0,
                    note: tx.note || '',
                    timestamp: tx.timestamp,
                    signature: tx.signature
                });
            }
        }

        if (rollbackTx.length > 0) {
            // 加到 pendingTransactions 头部，让回滚交易优先被重新打包
            this.pendingTransactions = rollbackTx.concat(this.pendingTransactions);
            console.log(`🔄 分叉回滚：已将 ${rollbackTx.length} 笔用户交易放回交易池`);
        }
        if (rollbackRewardCount > 0) {
            console.log(`⛏️  分叉回滚：旧链上 ${rollbackRewardCount} 个区块的矿工奖励已作废（共 ${rollbackRewardAmount} 币，因链被替换自动回滚）`);
        }

        // ---------------------------------------------------------
        // 正式替换链
        // ---------------------------------------------------------
        this.chain = newChain.map((b) => {
            if (b instanceof Block) return b;
            const txSrc = b.transactions || (b.data ? b.data : []);
            const block = new Block(b.index, b.timestamp, txSrc, b.previousHash);
            block.nonce = b.nonce;
            block.hash = b.hash;
            return block;
        });
        this.saveToFile();
        console.log(`✅ 链已替换，新长度: ${this.chain.length}（回滚了 ${rollbackTx.length} 笔交易到交易池）`);
        return true;
    }
}

module.exports = { Blockchain, Block, Transaction, generateWallet };