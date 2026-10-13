/* EVM panel: reuse the selected wallet; secrets only live in request-local variables. */
const evmUi = { address: null, busy: false, network: null, lastDeployment: null };
const evmEl = id => document.getElementById(id);
function evmJson(value) { return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2); }
async function evmApi(path, body) {
    const result = await api('/api/evm/' + path, body ? 'POST' : 'GET', body);
    if (!result.success) throw new Error(result.error || 'EVM 请求失败');
    return result;
}
function evmInterface() { return new ethers.Interface(JSON.parse(evmEl('evmAbi').value || '[]')); }
function evmParams(id) {
    const params = JSON.parse(evmEl(id).value || '[]');
    if (!Array.isArray(params)) throw new Error('参数必须是 JSON 数组');
    const validate = value => {
        if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('大整数请用引号，避免丢失精度');
        if (Array.isArray(value)) value.forEach(validate);
        else if (value && typeof value === 'object') Object.values(value).forEach(validate);
    };
    params.forEach(validate); return params;
}
async function evmSecret() {
    const wallet = state.wallets[state.selectedWallet];
    if (!wallet) throw new Error('请先选择钱包');
    return decryptPrivateKey(wallet.encryptedPrivateKey);
}
async function evmAction(action) {
    if (evmUi.busy) return;
    evmUi.busy = true;
    const buttons = Array.from(evmEl('evmPanel').querySelectorAll('button'));
    buttons.forEach(button => { button.disabled = true; });
    try { await action(); }
    catch (error) { evmEl('evmResult').textContent = '操作失败：' + error.message; }
    finally { evmUi.busy = false; buttons.forEach(button => { button.disabled = false; }); }
}
async function refreshEvmWallet() {
    if (typeof mmMode === 'function' && mmMode()) { await mmRefreshWallet(); return; }
    const wallet = state.wallets[state.selectedWallet];
    try {
        evmUi.network = await evmApi('status');
        const network = evmUi.network;
        const fee = network.metamask ? `动态 baseFee ${ethers.formatUnits(network.metamask.baseFeePerGas, 'gwei')} gwei` : `Gas 价格 ${ethers.formatUnits(network.gasPriceWei, 'gwei')} gwei`;
        evmEl('evmNetwork').textContent = `Chain ID ${network.chainId} · ${network.hardfork} · ${fee} · 激活高度 ${network.activationHeight}`;
        if (!wallet) { evmUi.address = null; evmEl('evmWallet').textContent = '请选择一个钱包'; return; }
        const derived = await evmApi('address', { publicKey: wallet.publicKey });
        const account = await evmApi('account/' + derived.address);
        if (wallet !== state.wallets[state.selectedWallet] || (typeof mmMode === 'function' && mmMode())) return;
        evmUi.address = derived.address;
        evmEl('evmWallet').textContent = `${wallet.label} · ${derived.address}\nEVM 余额 ${account.balanceSTC} STC · 已确认 nonce ${account.nonce}`;
        if (evmEl('evmReceiptId').value) await evmReadReceipt();
    } catch (error) { evmEl('evmWallet').textContent = error.message; }
}
async function evmReadReceipt() {
    const id = evmEl('evmReceiptId').value.trim();
    if (!id) throw new Error('请填写交易 ID');
    const receipt = id.startsWith('0x') ? await mmReceipt(id) : (await evmApi('receipt/' + id)).receipt;
    const states = { pending: '待打包，请挖矿确认', reverted: '已因分叉回滚', unknown: '未找到该交易', 0: '执行失败，Gas 已扣除', 1: '已确认，执行成功' };
    evmEl('evmReceiptStatus').textContent = `${states[receipt.status]}${receipt.gasUsed ? ' · Gas ' + receipt.gasUsed : ''}${receipt.confirmations ? ' · ' + receipt.confirmations + ' 个确认' : ''}`;
    if (receipt.contractAddress && receipt.status === 1 && evmUi.lastDeployment !== id) {
        evmEl('evmContract').value = receipt.contractAddress; evmUi.lastDeployment = id;
    }
    let decodedLogs = [];
    try { const iface = evmInterface(); decodedLogs = (receipt.logs || []).map(log => { const parsed = iface.parseLog(log); return parsed ? { event: parsed.name, args: Array.from(parsed.args) } : log; }); } catch { /* Imported ABI may not describe these events. */ }
    evmEl('evmReceiptOutput').textContent = evmJson({ ...receipt, decodedLogs });
    return receipt;
}
function evmReceiptAction() { return evmAction(evmReadReceipt); }
function evmSubmitted(result) {
    evmEl('evmReceiptId').value = result.transaction.id;
    evmEl('evmReceiptStatus').textContent = '待打包，请挖矿确认';
    evmEl('evmReceiptOutput').textContent = '';
    evmEl('evmResult').textContent = '交易已提交：' + result.transaction.id + '\n请挖矿打包，然后查询回执。';
    debouncedRefreshAll('high');
}
function evmBridge(kind) {
    return evmAction(async () => {
        if (kind === 'withdraw' && mmMode()) { await mmWithdraw(); return; }
        const privateKey = await evmSecret();
        const evmAddress = evmEl('evmDepositTarget').value.trim() || (mmMode() ? mmState.address : undefined);
        if (kind === 'deposit' && mmMode() && !evmAddress) throw new Error('请连接 MetaMask 或填写存入地址');
        evmSubmitted(await evmApi(kind, { privateKey, amount: evmEl('evmBridgeAmount').value.trim(),
            ...(kind === 'deposit' ? { evmAddress } : { nativeAddress: evmEl('evmNativeRecipient').value.trim() || undefined }) }));
    });
}
function evmLoadMethods() {
    try {
        const iface = evmInterface(), select = evmEl('evmMethod'); select.replaceChildren();
        const methods = iface.fragments.filter(fragment => fragment.type === 'function');
        for (const method of methods) {
            const option = document.createElement('option'); option.value = method.format('sighash');
            option.textContent = `${option.value} · ${['view', 'pure'].includes(method.stateMutability) ? '查询' : '交易'}`; select.append(option);
        }
        evmMethodChanged();
    } catch (error) { evmEl('evmResult').textContent = 'ABI 无效：' + error.message; }
}
function evmMethodChanged() {
    const name = evmEl('evmMethod').value; if (!name) return;
    const method = evmInterface().getFunction(name), readonly = ['view', 'pure'].includes(method.stateMutability);
    evmEl('evmExecuteBtn').textContent = readonly ? '查询方法' : '提交合约交易';
    evmEl('evmMethodHint').textContent = method.inputs.length ? '参数：' + method.inputs.map(input => `${input.name || 'arg'} (${input.type})`).join('，') : '此方法无需参数';
    evmEl('evmArgs').value = evmJson(method.inputs.map(input => input.type.startsWith('uint') || input.type.startsWith('int') ? '0' : input.type === 'address' ? evmUi.address || '' : input.type === 'bool' ? false : ''));
}
function evmUseArtifact(artifact) {
    const bytecode = typeof artifact.bytecode === 'string' ? artifact.bytecode : artifact.bytecode?.object;
    if (!Array.isArray(artifact.abi)) throw new Error('文件须包含 abi 数组');
    evmEl('evmAbi').value = evmJson(artifact.abi);
    evmEl('evmBytecode').value = bytecode ? (bytecode.startsWith('0x') ? bytecode : '0x' + bytecode) : '';
    evmEl('evmConstructorArgs').value = evmJson(artifact.constructorArgs || []);
    evmEl('evmGas').value = '1000000';
    evmLoadMethods();
    evmEl('evmResult').textContent = '已加载 ' + (artifact.contractName || '合约') + '。部署需要 EVM 余额；已有合约可直接填写地址调用。';
}
function evmLoadExample(name) { return evmAction(async () => { const response = await fetch('/contracts/' + name + '.json'); if (!response.ok) throw new Error('示例加载失败'); evmUseArtifact(await response.json()); }); }
function evmImportArtifact(input) {
    return evmAction(async () => { const file = input.files[0]; if (!file) return; if (file.size > 1000000) throw new Error('合约 JSON 超过 1 MB'); evmUseArtifact(JSON.parse(await file.text())); input.value = ''; });
}
function evmTxOptions(deploy) {
    const iface = evmInterface(), gasLimit = evmEl('evmGas').value.trim();
    const valueWei = ethers.parseEther(evmEl('evmValue').value.trim() || '0').toString();
    if (deploy) {
        const bytecode = evmEl('evmBytecode').value.trim();
        if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(bytecode)) throw new Error('请加载有效的部署字节码');
        return { data: bytecode + iface.encodeDeploy(evmParams('evmConstructorArgs')).slice(2), gasLimit, valueWei };
    }
    if (!evmEl('evmMethod').value) throw new Error('请先加载 ABI');
    return { to: ethers.getAddress(evmEl('evmContract').value.trim()), data: iface.encodeFunctionData(evmEl('evmMethod').value, evmParams('evmArgs')), gasLimit, valueWei };
}
function evmEstimate(deploy) {
    return evmAction(async () => {
        if (mmMode()) { await mmEstimate(deploy); return; }
        const result = await evmApi('estimate', { ...evmTxOptions(deploy), gasLimit: String(evmUi.network?.transactionGasLimit || 5000000), privateKey: await evmSecret() });
        // Keep a modest buffer for subsequent state changes; all values remain decimal strings.
        const gas = BigInt(result.gasLimit) * 120n / 100n;
        evmEl('evmGas').value = (gas > BigInt(evmUi.network?.transactionGasLimit || 5000000) ? BigInt(evmUi.network?.transactionGasLimit || 5000000) : gas).toString();
        evmEl('evmResult').textContent = `模拟成功 · 实际消耗 ${result.gasUsed} Gas\n已填写含 20% 余量的 Gas 上限 ${evmEl('evmGas').value}。估算不改变链上状态。`;
    });
}
function evmExecute(deploy) {
    return evmAction(async () => {
        if (mmMode()) { await mmExecute(deploy); return; }
        const options = evmTxOptions(deploy);
        const readonly = !deploy && ['view', 'pure'].includes(evmInterface().getFunction(evmEl('evmMethod').value).stateMutability);
        if (readonly) {
            const result = await evmApi('call', { ...options, from: evmUi.address || undefined });
            if (!result.status) throw new Error(result.error || '调用失败');
            evmEl('evmResult').textContent = '查询结果：\n' + evmJson(Array.from(evmInterface().decodeFunctionResult(evmEl('evmMethod').value, result.returnData)));
        } else evmSubmitted(await evmApi('transaction', { ...options, privateKey: await evmSecret() }));
    });
}
