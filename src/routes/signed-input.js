const { AppError } = require('./error-handler');
const { Transaction } = require('../core');
const nativeFields = ['version', 'chainId', 'id', 'from', 'to', 'amount', 'fee', 'note', 'currency', 'nonce', 'timestamp', 'publicKey', 'signature'];
function signedTransaction(body, version) {
    const data = body?.transaction;
    const fields = version === 3 ? [...nativeFields, 'kind', 'evmAddress', 'rawTransaction'] : nativeFields;
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(body).some(key => key !== 'transaction')
        || Object.keys(data).some(key => !fields.includes(key)) || data.version !== version) {
        throw new AppError(400, '仅接受规定格式的已签名交易，不能包含钱包秘密', 'INVALID_SIGNED_TRANSACTION');
    }
    const tx = Transaction.fromJSON(data);
    if (!tx.isValid()) throw new AppError(400, '交易签名验证失败', 'INVALID_SIGNATURE');
    return tx;
}
module.exports = signedTransaction;
