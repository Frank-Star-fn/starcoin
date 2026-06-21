// StarCoin 简单区块链实现
const crypto = require('crypto');

class Block {
    constructor(index, timestamp, data, previousHash = '') {
        this.index = index;
        this.timestamp = timestamp;
        this.data = data;
        this.previousHash = previousHash;
        this.hash = this.calculateHash();
        this.nonce = 0;
    }

    calculateHash() {
        return crypto.createHash('sha256').update(
            this.index + this.previousHash + this.timestamp + JSON.stringify(this.data) + this.nonce
        ).digest('hex');
    }

    mineBlock(difficulty) {
        while (this.hash.substring(0, difficulty) !== Array(difficulty + 1).join('0')) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
    }
}

class Blockchain {
    constructor() {
        this.chain = [this.createGenesisBlock()];
        this.difficulty = 2;
    }

    createGenesisBlock() {
        return new Block(0, new Date().toISOString(), { data: '创世区块：StarCoin诞生！' }, '0');
    }

    getLatestBlock() {
        return this.chain[this.chain.length - 1];
    }

    addBlock(newBlock) {
        newBlock.previousHash = this.getLatestBlock().hash;
        newBlock.mineBlock(this.difficulty);
        this.chain.push(newBlock);
        return newBlock;
    }

    isChainValid() {
        for (let i = 1; i < this.chain.length; i++) {
            const currentBlock = this.chain[i];
            const previousBlock = this.chain[i - 1];

            if (currentBlock.hash !== currentBlock.calculateHash()) {
                return false;
            }

            if (currentBlock.previousHash !== previousBlock.hash) {
                return false;
            }
        }
        return true;
    }

    // 可视化显示区块链
    visualizeChain() {
        console.log('\n' + '='.repeat(80));
        console.log('🎇 StarCoin 区块链可视化 🎇'.padStart(50));
        console.log('='.repeat(80) + '\n');

        this.chain.forEach((block, index) => {
            const isGenesis = index === 0;
            const blockType = isGenesis ? '🌱 创世区块' : '📦 交易区块';
            const indent = isGenesis ? '' : '  ';

            console.log(`${indent}${blockType} #${block.index}`);
            console.log(`${indent}├─ 🕐 时间: ${new Date(block.timestamp).toLocaleString()}`);
            console.log(`${indent}├─ 📝 内容: ${block.data.data}`);
            console.log(`${indent}├─ 🔗 前哈希: ${block.previousHash.substring(0, 16)}...`);
            console.log(`${indent}├─ 🔒 本哈希: ${block.hash.substring(0, 16)}...`);
            console.log(`${indent}└─ ⚙️  Nonce: ${block.nonce}`);
            
            if (!isGenesis) {
                console.log(`${indent}   ↓`);
            }
            console.log();
        });

        // 显示区块链结构示意图
        console.log('📊 区块链结构示意图:');
        console.log('  ' + this.chain.map((_, i) => `[${i}]`).join(' ← '));
        console.log();

        // 显示统计信息
        console.log('📈 区块链统计:');
        console.log(`├─ 🧱 区块总数: ${this.chain.length}`);
        console.log(`├─ 🎯 挖矿难度: ${this.difficulty}`);
        console.log(`├─ ✅ 有效性: ${this.isChainValid() ? '有效' : '无效'}`);
        console.log(`└─ 🔑 创世区块: ${this.chain[0].hash.substring(0, 16)}...`);
        console.log('='.repeat(80) + '\n');
    }

    // 可视化显示挖矿过程
    visualizeMining(blockData) {
        console.log('\n' + '-'.repeat(60));
        console.log('⛏️  开始挖矿:'.padStart(35));
        console.log(`📝 交易内容: ${blockData.data}`);
        console.log('-'.repeat(60));

        const startTime = Date.now();
        const newBlock = this.addBlock(new Block(this.chain.length, new Date().toISOString(), blockData));
        const miningTime = Date.now() - startTime;

        console.log('🎉 挖矿成功!'.padStart(35));
        console.log(`⏱️  耗时: ${miningTime}ms`);
        console.log(`🔍 Nonce: ${newBlock.nonce}`);
        console.log(`🔒 区块哈希: ${newBlock.hash}`);
        console.log('-'.repeat(60) + '\n');

        return newBlock;
    }
}

// 初始化StarCoin
const starCoin = new Blockchain();

// 生成创世区块
console.log('=== 生成创世区块 ===');
console.log(`区块高度: ${starCoin.chain[0].index}`);
console.log(`区块哈希: ${starCoin.chain[0].hash}`);
console.log(`前一区块哈希: ${starCoin.chain[0].previousHash}`);
console.log(`
`);

// 添加交易
starCoin.visualizeMining({ data: 'Alice给Bob 10个StarCoin' });
starCoin.visualizeMining({ data: 'Bob给Charlie 5个StarCoin' });
starCoin.visualizeMining({ data: 'Charlie给Alice 3个StarCoin' });

// 可视化显示完整区块链
starCoin.visualizeChain();

// 模拟区块链验证
console.log('🔍 正在验证区块链完整性...');
setTimeout(() => {
    const isValid = starCoin.isChainValid();
    console.log(`\n✅ 区块链验证结果: ${isValid ? '有效' : '无效'}`);
    if (isValid) {
        console.log('🎉 区块链运行正常，所有交易都已安全记录！');
    } else {
        console.log('⚠️  区块链可能已被篡改，请检查！');
    }
}, 1000);