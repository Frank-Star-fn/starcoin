const crypto = require('crypto');
const { createVM, runTx } = require('@ethereumjs/vm');
const { createCustomCommon, Mainnet, Hardfork } = require('@ethereumjs/common');
const { MerkleStateManager } = require('@ethereumjs/statemanager');
const { createLegacyTx, createTx, createTxFromRLP } = require('@ethereumjs/tx');
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
            gasLimit: BigInt(this.settings.blockGasLimit), baseFeePerGas: uint(context.baseFeePerGas ?? '0'), difficulty: 0n,
            coinbase: GAS_ACCOUNT, mixHash: '0x' + (context.previousHash || '0'.repeat(64)) } },
        { common: this.vm.common, skipConsensusFormatValidation: true });
    }

    decode(raw, modern = false) {
        const tx = createTxFromRLP(hexToBytes(hex(raw)), { common: this.vm.common });
        if (!(modern ? [0, 1, 2] : [0]).includes(tx.type) || !tx.isSigned() || !tx.verifySignature()
            || tx.common.chainId() !== BigInt(this.settings.chainId)
            || (tx.type === 0 && tx.v !== BigInt(this.settings.chainId) * 2n + 35n && tx.v !== BigInt(this.settings.chainId) * 2n + 36n)
            || (!modern && tx.gasPrice !== BigInt(this.settings.gasPriceWei))
            || tx.gasLimit > BigInt(this.settings.transactionGasLimit)
            || tx.nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('EVM 签名、chainId、Gas 价格、Gas 上限或 nonce 无效');
        return tx;
    }

    sign(pem, options, modern = false) {
        const gasLimit = uint(String(options.gasLimit ?? this.settings.transactionGasLimit), 'gasLimit');
        const tx = createLegacyTx({ nonce: uint(String(options.nonce), 'nonce'), gasLimit,
            gasPrice: uint(options.gasPrice ?? this.settings.gasPriceWei), value: uint(options.valueWei ?? '0', 'valueWei'),
            to: options.to ? address(options.to) : undefined, data: hexToBytes(hex(options.data ?? '0x')) }, { common: this.vm.common });
        const raw = bytesToHex(tx.sign(privateBytes(pem)).serialize());
        this.decode(raw, modern);
        return raw;
    }

    async execute(raw, context, gasUsed = 0n, modern = false) {
        return this.executeTransaction(this.decode(raw, modern), context, gasUsed);
    }

    async executeTransaction(tx, context, gasUsed = 0n, skipBalance = false) {
        // runTx only checks the individual limit; the host must enforce remaining block Gas.
        if (gasUsed + tx.gasLimit > BigInt(this.settings.blockGasLimit)) throw new Error('交易 Gas 上限超过区块剩余 Gas');
        const result = await runTx(this.vm, { tx, block: this.block(context), blockGasUsed: gasUsed, skipBalance });
        const fee = result.amountSpent;
        // Native StarCoin fees are burned; apply the same policy to the VM's miner credit.
        if (result.minerValue) await this.moveBalance(GAS_ACCOUNT, -result.minerValue);
        return { transactionHash: tx.isSigned() ? bytesToHex(tx.hash()) : null, from: tx.getSenderAddress().toString(),
            to: tx.to?.toString() || null, contractAddress: result.execResult.exceptionError ? null : result.createdAddress?.toString() || null,
            status: result.execResult.exceptionError ? 0 : 1, gasUsed: result.totalGasSpent.toString(),
            gasPriceWei: (fee / result.totalGasSpent).toString(), feeWei: fee.toString(), valueWei: tx.value.toString(),
            returnData: bytesToHex(result.execResult.returnValue), error: result.execResult.exceptionError ? String(result.execResult.exceptionError.error) : null,
            logs: result.receipt.logs.map(([emitter, topics, data], index) => ({ address: bytesToHex(emitter),
                topics: topics.map(bytesToHex), data: bytesToHex(data), logIndex: index })) };
    }

    // Unsigned simulation is isolated and is never accepted by consensus or submitted to the pool.
    async simulate(options, context) {
        const isolated = await this.fork();
        const from = address(options.from || '0x' + '0'.repeat(40));
        const type = options.maxFeePerGas !== undefined ? 2 : options.accessList !== undefined ? 1 : 0;
        const base = uint(context.baseFeePerGas ?? '0');
        const tx = createTx({ type, chainId: BigInt(this.settings.chainId), nonce: await isolated.nonce(from),
            to: options.to ? address(options.to) : undefined, value: uint(options.valueWei ?? '0'), data: hexToBytes(hex(options.data ?? '0x')),
            gasLimit: uint(String(options.gasLimit ?? this.settings.transactionGasLimit)), accessList: options.accessList ?? [],
            gasPrice: uint(options.gasPrice ?? (base + 1000000000n).toString()),
            maxFeePerGas: uint(options.maxFeePerGas ?? (base * 2n + 1000000000n).toString()),
            maxPriorityFeePerGas: uint(options.maxPriorityFeePerGas ?? '1000000000') }, { common: isolated.vm.common, freeze: false });
        tx.getSenderAddress = () => createAddressFromString(from);
        if (tx.gasLimit > BigInt(this.settings.transactionGasLimit)) throw new Error('模拟 Gas 上限过大');
        return isolated.executeTransaction(tx, context, 0n, !options.from);
    }

    async call(options, context) {
        const isolated = await this.fork();
        let gasLimit = uint(String(options.gasLimit ?? this.settings.transactionGasLimit), 'gasLimit');
        if (gasLimit > BigInt(this.settings.transactionGasLimit)) throw new Error('调用 Gas 上限过大');
        const from = createAddressFromString(address(options.from || '0x' + '0'.repeat(40)));
        if (options.transactionGas) {
            // JSON-RPC call gas includes intrinsic cost, just like a submitted transaction.
            const tx = createTx({ type: options.accessList === undefined ? 0 : 1, to: options.to, data: hexToBytes(hex(options.data || '0x')),
                gasLimit, gasPrice: 0n, accessList: options.accessList || [] }, { common: isolated.vm.common });
            const intrinsic = tx.getIntrinsicGas();
            if (gasLimit < intrinsic) return { status: 0, returnData: '0x', executionGasUsed: '0', error: 'intrinsic gas too low' };
            gasLimit -= intrinsic;
            const journal = isolated.vm.evm.journal;
            for (const target of [from.toString(), options.to, GAS_ACCOUNT, ...isolated.vm.evm.precompiles.keys()]) if (target) journal.addAlwaysWarmAddress(target.replace(/^0x/, ''));
            for (const item of options.accessList || []) {
                journal.addAlwaysWarmAddress(item.address.slice(2));
                for (const slot of item.storageKeys) journal.addAlwaysWarmSlot(item.address.slice(2), slot.slice(2));
            }
        }
        const result = await isolated.vm.evm.runCall({ caller: from, origin: from, to: options.to ? createAddressFromString(address(options.to)) : undefined,
            data: hexToBytes(hex(options.data || '0x')), value: uint(options.valueWei ?? '0'), gasLimit,
            gasPrice: uint(options.gasPrice ?? '0'), block: isolated.block(context) });
        return { status: result.execResult.exceptionError ? 0 : 1, returnData: bytesToHex(result.execResult.returnValue),
            executionGasUsed: result.execResult.executionGasUsed.toString(), error: result.execResult.exceptionError ? String(result.execResult.exceptionError.error) : null };
    }
}

module.exports = { EvmEngine, address, hex, uint, evmAddressFromPem, evmAddressFromPublicKey, WEI_PER_UNIT };
