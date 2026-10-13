const { hash } = require('../protocol');
const { uint } = require('./engine');

function rpcSettings(options) {
    if (!options) return null;
    const settings = { activationHeight: options.activationHeight ?? 1, checkpointHash: options.checkpointHash ?? '',
        initialBaseFeeWei: options.initialBaseFeeWei ?? '10000000000', priorityFeeWei: options.priorityFeeWei ?? '1000000000' };
    if (!Number.isSafeInteger(settings.activationHeight) || settings.activationHeight < 1
        || (settings.activationHeight > 1 && !/^[0-9a-f]{64}$/.test(settings.checkpointHash))
        || uint(settings.initialBaseFeeWei) === 0n || uint(settings.priorityFeeWei) === 0n) throw new Error('无效 MetaMask 升级配置');
    return Object.freeze({ ...settings, fingerprint: hash(JSON.stringify(settings)) });
}

function nextBaseFee(previous, settings, height, gasLimit) {
    if (!settings || height < settings.activationHeight) return 0n;
    if (height === settings.activationHeight) return BigInt(settings.initialBaseFeeWei);
    const base = uint(previous.baseFeePerGas), used = uint(previous.evmGasUsed), target = BigInt(gasLimit) / 2n;
    if (used === target) return base;
    if (used > target) { const change = base * (used - target) / target / 8n; return base + (change || 1n); }
    return base - base * (target - used) / target / 8n;
}
module.exports = { rpcSettings, nextBaseFee };
