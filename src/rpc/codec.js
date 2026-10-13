const engine = require('../evm/engine');
class RpcError extends Error {
    constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}
const q = value => '0x' + BigInt(value).toString(16);
function address(value) { try { return engine.address(value); } catch (error) { throw new RpcError(-32602, error.message); } }
function hex(value, maxBytes) { try { return engine.hex(value, maxBytes); } catch (error) { throw new RpcError(-32602, error.message); } }
function quantity(value, name = 'quantity') {
    if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)) throw new RpcError(-32602, name + ' 必须为规范十六进制数量');
    return BigInt(value);
}
function integer(value, name) {
    const n = quantity(value, name); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new RpcError(-32602, name + ' 过大'); return Number(n);
}
function hash32(value) { const data = hex(value, 32); if (data.length !== 66) throw new RpcError(-32602, '哈希必须为 32 字节'); return data; }
function options(value, context, settings, call = false) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcError(-32602, '必须提供交易对象');
    const data = hex(value.data ?? value.input ?? '0x');
    if (value.data !== undefined && value.input !== undefined && hex(value.input) !== data) throw new RpcError(-32602, 'data 与 input 不匹配');
    const result = { from: value.from === undefined ? undefined : address(value.from), to: value.to === undefined || value.to === null ? undefined : address(value.to),
        data, valueWei: value.value === undefined ? '0' : quantity(value.value, 'value').toString(),
        gasLimit: value.gas === undefined ? String(settings.transactionGasLimit) : quantity(value.gas, 'gas').toString() };
    if (BigInt(result.gasLimit) > BigInt(settings.transactionGasLimit)) throw new RpcError(-32602, 'gas 超过交易上限');
    if (value.nonce !== undefined) quantity(value.nonce, 'nonce');
    if (value.accessList !== undefined) {
        if (!Array.isArray(value.accessList) || value.accessList.length > 1024) throw new RpcError(-32602, '无效 accessList');
        result.accessList = value.accessList.map(item => {
            if (!item || !Array.isArray(item.storageKeys) || item.storageKeys.length > 4096) throw new RpcError(-32602, '无效 storageKeys');
            return { address: address(item.address), storageKeys: item.storageKeys.map(hash32) };
        });
    }
    const type = value.type === undefined ? null : integer(value.type, 'type');
    if (type !== null && ![0, 1, 2].includes(type)) throw new RpcError(-32602, '只支持 type 0/1/2');
    if (value.gasPrice !== undefined && (value.maxFeePerGas !== undefined || value.maxPriorityFeePerGas !== undefined || type === 2)) throw new RpcError(-32602, 'gasPrice 与 EIP-1559 费用字段不能同时指定');
    const base = BigInt(context.baseFeePerGas ?? '0'), tip = BigInt(settings.priorityFeeWei);
    if (type === 2 || value.maxFeePerGas !== undefined || value.maxPriorityFeePerGas !== undefined) {
        result.maxFeePerGas = value.maxFeePerGas === undefined ? (base * 2n + tip).toString() : quantity(value.maxFeePerGas, 'maxFeePerGas').toString();
        result.maxPriorityFeePerGas = value.maxPriorityFeePerGas === undefined ? tip.toString() : quantity(value.maxPriorityFeePerGas, 'maxPriorityFeePerGas').toString();
        if (BigInt(result.maxPriorityFeePerGas) > BigInt(result.maxFeePerGas)) throw new RpcError(-32602, 'priority fee 超过 max fee');
        result.gasPrice = (base + BigInt(result.maxPriorityFeePerGas) < BigInt(result.maxFeePerGas) ? base + BigInt(result.maxPriorityFeePerGas) : BigInt(result.maxFeePerGas)).toString();
    } else result.gasPrice = value.gasPrice === undefined ? (call ? 0n : base + tip).toString() : quantity(value.gasPrice, 'gasPrice').toString();
    if (type === 1 && !result.accessList) result.accessList = [];
    return result;
}
module.exports = { RpcError, q, quantity, integer, hash32, options, address, hex };
