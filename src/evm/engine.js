const crypto = require('crypto');
const { createVM, runTx } = require('@ethereumjs/vm');
const { createCustomCommon, Mainnet, Hardfork } = require('@ethereumjs/common');
const { MerkleStateManager } = require('@ethereumjs/statemanager');
const { createLegacyTx, createTxFromRLP } = require('@ethereumjs/tx');
const { createBlock } = require('@ethereumjs/block');
const { createAccount, createAddressFromString, createAddressFromPrivateKey,
    createAddressFromPublicKey, bytesToHex, hexToBytes } = require('@ethereumjs/util');
const { evmSettings, WEI_PER_UNIT } = require('./settings');

const GAS_ACCOUNT = '0x000000000000000000000000000000000000dead';

function address(value) {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('EVM 地址必须为 0x 开头的 20 字节地址');
    return value.toLowerCase();
}

function hex(value, maxBytes = 100000) {
    if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) || value.length > maxBytes * 2 + 2) {
        throw new Error('无效或过大的十六进制数据');
    }
    return value.toLowerCase();
}

function uint(value, name = '数值') {
    const text = typeof value === 'bigint' ? value.toString() : value;
    if (typeof text !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(text) || BigInt(text) >= 1n << 256n) {
        throw new Error(`${name} 必须为非负整数字符串`);
    }
    return BigInt(text);
}

function privateBytes(pem) {
    const key = crypto.createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'secp256k1') throw new Error('EVM 需要 secp256k1 私钥');
    return new Uint8Array(Buffer.from(key.export({ format: 'jwk' }).d, 'base64url'));
}

function evmAddressFromPem(pem) { return createAddressFromPrivateKey(privateBytes(pem)).toString(); }

function evmAddressFromPublicKey(publicKey) {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'hex'), type: 'spki', format: 'der' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'secp256k1') throw new Error('EVM 需要 secp256k1 公钥');
    const jwk = key.export({ format: 'jwk' });
    return createAddressFromPublicKey(new Uint8Array(Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]))).toString();
}

function historyAdapter(ancestors) {
    return { async getBlock(number) {
        const index = Number(number);
        const block = ancestors[index];
        if (!block) throw new Error('EVM 历史区块不存在');
        return { hash: () => hexToBytes('0x' + block.hash) };
    }, shallowCopy() { return historyAdapter(ancestors); } };
}

class EvmEngine {
    constructor(vm, settings, ancestors) { this.vm = vm; this.settings = settings; this.ancestors = ancestors; }

    static async create(options = {}, ancestors = []) {
        const settings = evmSettings(options);
        const common = createCustomCommon({ chainId: settings.chainId }, Mainnet, { hardfork: Hardfork.Shanghai });
        const vm = await createVM({ common, stateManager: new MerkleStateManager({ common }), blockchain: historyAdapter(ancestors) });
        return new EvmEngine(vm, settings, ancestors);
    }

    async fork(ancestors = this.ancestors) {
        await this.vm.stateManager.flush();
        const common = this.vm.common.copy();
        const vm = await createVM({ common, stateManager: this.vm.stateManager.shallowCopy(), blockchain: historyAdapter(ancestors) });
        return new EvmEngine(vm, this.settings, ancestors);
    }

    async root() { return bytesToHex(await this.vm.stateManager.getStateRoot()); }
    async account(value) { return (await this.vm.stateManager.getAccount(createAddressFromString(address(value)))) || createAccount({ nonce: 0n, balance: 0n }); }
    async balance(value) { return (await this.account(value)).balance; }
    async nonce(value) { return (await this.account(value)).nonce; }
    async code(value) { return bytesToHex(await this.vm.stateManager.getCode(createAddressFromString(address(value)))); }
    async storage(value, slot) {
        const key = new Uint8Array(Buffer.from(uint(slot, '存储槽').toString(16).padStart(64, '0'), 'hex'));
        const data = await this.vm.stateManager.getStorage(createAddressFromString(address(value)), key);
        return '0x' + Buffer.from(data).toString('hex').padStart(64, '0');
    }

    async moveBalance(value, delta) {
        const target = createAddressFromString(address(value));
        const account = await this.account(value);
        account.balance += delta;
        if (account.balance < 0n || account.balance >= 1n << 256n) throw new Error('EVM 余额不足或溢出');
        await this.vm.stateManager.putAccount(target, account);
    }

    block(context) {
        return createBlock({ header: { number: BigInt(context.index), timestamp: BigInt(Math.floor(Date.parse(context.timestamp) / 1000)),
            gasLimit: BigInt(this.settings.blockGasLimit), baseFeePerGas: 0n, difficulty: 0n,
            coinbase: GAS_ACCOUNT, mixHash: '0x' + (context.previousHash || '0'.repeat(64)) } },
        { common: this.vm.common, skipConsensusFormatValidation: true });
    }

    decode(raw) {
        const tx = createTxFromRLP(hexToBytes(hex(raw)), { common: this.vm.common });
        if (tx.type !== 0 || !tx.isSigned() || !tx.verifySignature()
            || tx.common.chainId() !== BigInt(this.settings.chainId)
            || (tx.v !== BigInt(this.settings.chainId) * 2n + 35n && tx.v !== BigInt(this.settings.chainId) * 2n + 36n)
            || tx.gasPrice !== BigInt(this.settings.gasPriceWei)
            || tx.gasLimit > BigInt(this.settings.transactionGasLimit)
            || tx.nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('EVM 签名、chainId、Gas 价格、Gas 上限或 nonce 无效');
        return tx;
    }

    sign(pem, options) {
        const gasLimit = uint(String(options.gasLimit ?? this.settings.transactionGasLimit), 'gasLimit');
        const tx = createLegacyTx({ nonce: uint(String(options.nonce), 'nonce'), gasLimit,
            gasPrice: BigInt(this.settings.gasPriceWei), value: uint(options.valueWei ?? '0', 'valueWei'),
            to: options.to ? address(options.to) : undefined, data: hexToBytes(hex(options.data ?? '0x')) }, { common: this.vm.common });
        const raw = bytesToHex(tx.sign(privateBytes(pem)).serialize());
        this.decode(raw);
        return raw;
    }

    async execute(raw, context, gasUsed = 0n) {
        const tx = this.decode(raw);
        const result = await runTx(this.vm, { tx, block: this.block(context), blockGasUsed: gasUsed });
        const fee = result.totalGasSpent * tx.gasPrice;
        // Native StarCoin fees are burned; apply the same policy to the VM's miner credit.
        await this.moveBalance(GAS_ACCOUNT, -fee);
        return { transactionHash: bytesToHex(tx.hash()), from: tx.getSenderAddress().toString(),
            to: tx.to?.toString() || null, contractAddress: result.execResult.exceptionError ? null : result.createdAddress?.toString() || null,
            status: result.execResult.exceptionError ? 0 : 1, gasUsed: result.totalGasSpent.toString(),
            gasPriceWei: tx.gasPrice.toString(), feeWei: fee.toString(), valueWei: tx.value.toString(),
            returnData: bytesToHex(result.execResult.returnValue), error: result.execResult.exceptionError ? String(result.execResult.exceptionError.error) : null,
            logs: result.receipt.logs.map(([emitter, topics, data], index) => ({ address: bytesToHex(emitter),
                topics: topics.map(bytesToHex), data: bytesToHex(data), logIndex: index })) };
    }

    async call(options, context) {
        const isolated = await this.fork();
        const gasLimit = uint(String(options.gasLimit ?? this.settings.transactionGasLimit), 'gasLimit');
        if (gasLimit > BigInt(this.settings.transactionGasLimit)) throw new Error('调用 Gas 上限过大');
        const from = createAddressFromString(address(options.from || '0x' + '0'.repeat(40)));
        const result = await isolated.vm.evm.runCall({ caller: from, origin: from, to: options.to ? createAddressFromString(address(options.to)) : undefined,
            data: hexToBytes(hex(options.data || '0x')), value: uint(options.valueWei ?? '0'), gasLimit, block: isolated.block(context) });
        return { status: result.execResult.exceptionError ? 0 : 1, returnData: bytesToHex(result.execResult.returnValue),
            executionGasUsed: result.execResult.executionGasUsed.toString(), error: result.execResult.exceptionError ? String(result.execResult.exceptionError.error) : null };
    }
}

module.exports = { EvmEngine, address, hex, uint, evmAddressFromPem, evmAddressFromPublicKey, WEI_PER_UNIT };
