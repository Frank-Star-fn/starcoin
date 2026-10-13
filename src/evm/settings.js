const { hash } = require('../protocol');

const WEI_PER_UNIT = 10000000000n;
const DEFAULT_EVM = Object.freeze({ chainId: 155001, hardfork: 'shanghai',
    blockGasLimit: 30000000, transactionGasLimit: 5000000, gasPriceWei: '10000000000',
    activationHeight: 1, checkpointHash: '' });

function evmSettings(options = {}) {
    const settings = Object.fromEntries(Object.keys(DEFAULT_EVM).map(k => [k, options[k] ?? DEFAULT_EVM[k]]));
    if (!Number.isSafeInteger(settings.chainId) || settings.chainId < 1
        || settings.hardfork !== 'shanghai'
        || !Number.isSafeInteger(settings.activationHeight) || settings.activationHeight < 1
        || (settings.activationHeight > 1 && !/^[0-9a-f]{64}$/.test(settings.checkpointHash))
        || !Number.isSafeInteger(settings.blockGasLimit) || settings.blockGasLimit < 21000 || settings.blockGasLimit > 100000000
        || !Number.isSafeInteger(settings.transactionGasLimit) || settings.transactionGasLimit < 21000
        || settings.transactionGasLimit > settings.blockGasLimit
        || typeof settings.gasPriceWei !== 'string' || !/^[1-9][0-9]{0,20}$/.test(settings.gasPriceWei)
        || BigInt(settings.gasPriceWei) % WEI_PER_UNIT !== 0n) throw new Error('无效 EVM 共识配置');
    return Object.freeze({ ...settings, fingerprint: hash(JSON.stringify(settings)) });
}

module.exports = { DEFAULT_EVM, WEI_PER_UNIT, evmSettings };
