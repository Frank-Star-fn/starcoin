/* EVM panel: sign in the browser; only public simulation inputs and signed transactions leave it. */
const evmUi = { address: null, busy: false, network: null, lastDeployment: null, artifactName: '自定义合约', parameterFields: {} };
const evmEl = id => document.getElementById(id);
function evmJson(value) { return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2); }
async function evmApi(path, body) {
    const result = await api('/api/evm/' + path, body ? 'POST' : 'GET', body);
    if (!result.success) throw new Error(result.error || 'EVM 请求失败');
    return result;
}
function evmInterface() { return new ethers.Interface(JSON.parse(evmEl('evmAbi').value || '[]')); }
function evmParams(id) {
    evmSyncParameterFields(id);
    const params = JSON.parse(evmEl(id).value || '[]');
    if (!Array.isArray(params)) throw new Error('参数必须是 JSON 数组');
    const validate = value => {
        if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('大整数请用引号，避免丢失精度');
        if (Array.isArray(value)) value.forEach(validate);
        else if (value && typeof value === 'object') Object.values(value).forEach(validate);
    };
    params.forEach(validate); return params;
}
function evmSyncParameterFields(id) {
    const group = evmUi.parameterFields[id];
    if (!group || group.json.open || group.complex) return;
    evmEl(id).value = evmJson(group.fields.map(({ input, param }) => {
        const value = input.value.trim();
        if (param.type === 'bool') return value === 'true';
        if (/^u?int[0-9]*$/.test(param.type) && !/^-?[0-9]+$/.test(value)) throw new Error('请为 ' + (param.name || '整数参数') + ' 填写整数');
        return value;
    }));
}
function evmBuildParameterFields(id, inputs) {
    const original = evmEl(id); if (!original) return;
    let group = evmUi.parameterFields[id];
    if (!group) {
        const host = document.createElement('div'); host.className = 'parameter-fields'; host.id = id + 'Fields';
        const json = document.createElement('details'); json.className = 'advanced-options';
        const summary = document.createElement('summary'); summary.textContent = '高级模式：JSON 参数';
        const label = original.previousElementSibling; label.before(host, json); json.append(summary, label, original);
        group = evmUi.parameterFields[id] = { host, json, fields: [] };
        original.addEventListener('input', () => { try { const values = JSON.parse(original.value); group.fields.forEach((field, i) => { field.input.value = String(values[i] ?? ''); }); } catch {} });
    }
    group.host.replaceChildren(); group.fields = [];
    group.host.hidden = !inputs.length && id === 'evmArgs'; group.json.hidden = !inputs.length;
    const complex = inputs.some(param => /\[|tuple/.test(param.type)); group.complex = complex; group.json.open = complex;
    if (complex) { group.host.textContent = '数组或结构参数请使用下方 JSON 模式。'; return; }
    let defaults = []; try { defaults = JSON.parse(original.value); } catch {}
    const labels = { to: '收款地址', from: '持币账户地址', spender: '被授权账户地址', owner: '持币账户地址', supply: '发行数量（最小单位）' };
    inputs.forEach((param, index) => {
        const wrapper = document.createElement('div'); wrapper.className = 'parameter-field';
        const label = document.createElement('label'); label.htmlFor = id + '-param-' + index;
        const tokenAmount = evmUi.artifactName === 'DemoToken' && param.name === 'value';
        label.textContent = (labels[param.name] || (tokenAmount ? '代币数量（最小单位）' : param.name === 'value' ? '写入的值' : param.name || '参数 ' + (index + 1))) + ' · ' + param.type;
        const input = document.createElement(param.type === 'bool' ? 'select' : 'input'); input.id = label.htmlFor;
        if (param.type === 'bool') { input.add(new Option('true', 'true')); input.add(new Option('false', 'false')); }
        input.value = String(defaults[index] ?? (param.type === 'bool' ? false : ''));
        input.autocomplete = 'off'; if (param.type === 'address') input.placeholder = '0x 开头的 EVM 地址';
        input.addEventListener('input', () => { if (!group.json.open) try { evmSyncParameterFields(id); } catch {} });
        wrapper.append(label, input); group.host.append(wrapper); group.fields.push({ input, param });
    });
    if (!inputs.length) group.host.textContent = '此操作无需参数。';
}
function evmArtifactSnapshot() { return { name: evmUi.artifactName, abi: JSON.parse(evmEl('evmAbi').value || '[]') }; }
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
        if (typeof mmMode === 'function' && mmMode()) return;
        const network = evmUi.network;
        const fee = network.metamask ? `动态 baseFee ${ethers.formatUnits(network.metamask.baseFeePerGas, 'gwei')} gwei` : `Gas 价格 ${ethers.formatUnits(network.gasPriceWei, 'gwei')} gwei`;
        evmEl('evmNetwork').textContent = `StarCoin · Chain ID ${network.chainId} · ${fee}`;
        evmEl('mmConnection').textContent = '使用所选本地钱包签名。';
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
        const record = typeof workspaceState === 'undefined' ? null : workspaceState.activity.find(item => item.id === id);
        if (!record?.artifact || JSON.stringify(record.artifact.abi) === JSON.stringify(JSON.parse(evmEl('evmAbi').value || '[]'))) evmEl('evmContract').value = receipt.contractAddress;
        evmUi.lastDeployment = id;
    }
    let decodedLogs = [];
    try { const iface = evmInterface(); decodedLogs = (receipt.logs || []).map(log => { const parsed = iface.parseLog(log); return parsed ? { event: parsed.name, args: Array.from(parsed.args) } : log; }); } catch { /* Imported ABI may not describe these events. */ }
    evmEl('evmReceiptOutput').textContent = evmJson({ ...receipt, decodedLogs });
    if (typeof recordContractReceipt === 'function') recordContractReceipt(receipt, id);
    return receipt;
}
function evmReceiptAction() { return evmAction(evmReadReceipt); }
function evmSubmitted(result, kind = result.transaction.kind, artifact = null) {
    evmEl('evmReceiptId').value = result.transaction.id;
    evmEl('evmReceiptStatus').textContent = '待打包，请挖矿确认';
    evmEl('evmReceiptOutput').textContent = '';
    evmEl('evmResult').textContent = '交易已提交：' + result.transaction.id + '\n请挖矿打包，然后查询回执。';
    if (typeof trackContractTransaction === 'function') { trackContractTransaction(result.transaction.id, kind, artifact); showContractTab('receipts'); }
    debouncedRefreshAll('high');
}
function evmBridge(kind) {
    return evmAction(async () => {
        if (kind === 'withdraw' && mmMode()) { await mmWithdraw(); return; }
        const pem = await evmSecret(), wallet = walletCrypto.importPem(pem);
        const evmAddress = evmEl('evmDepositTarget').value.trim() || (mmMode() ? mmState.address : undefined);
        if (kind === 'deposit' && mmMode() && !evmAddress) throw new Error('请连接 MetaMask 或填写存入地址');
        const source = ethers.computeAddress(walletCrypto.rawFromPem(pem)).toLowerCase();
        const target = kind === 'deposit' ? ethers.getAddress(evmAddress || source).toLowerCase()
            : evmEl('evmNativeRecipient').value.trim() || wallet.address;
        if (kind === 'withdraw' && !/^[0-9a-f]{32}$/.test(target)) throw new Error('请填写有效的原生收款地址');
        const context = await api('/api/transaction/context/' + wallet.address);
        const transaction = walletCrypto.signEnvelope(pem, { kind, chainId: context.chainId, nonce: context.nextNonce,
            to: kind === 'deposit' ? 'EVM:' + target : target, evmAddress: kind === 'deposit' ? target : source,
            amount: evmEl('evmBridgeAmount').value.trim() });
        evmSubmitted(await evmApi('signed', { transaction }));
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
        if (evmEl('evmWatchTokenBtn')) evmEl('evmWatchTokenBtn').hidden = !['balanceOf', 'symbol', 'decimals'].every(name => methods.some(method => method.name === name));
        evmMethodChanged();
    } catch (error) { evmEl('evmResult').textContent = 'ABI 无效：' + error.message; }
}
function evmMethodChanged() {
    const name = evmEl('evmMethod').value; if (!name) return;
    const method = evmInterface().getFunction(name), readonly = ['view', 'pure'].includes(method.stateMutability);
    evmEl('evmExecuteBtn').textContent = readonly ? '查询方法' : '提交合约交易';
    if (evmEl('evmEstimateCallBtn')) evmEl('evmEstimateCallBtn').hidden = readonly;
    evmEl('evmMethodHint').textContent = method.inputs.length ? '参数：' + method.inputs.map(input => `${input.name || 'arg'} (${input.type})`).join('，') : '此方法无需参数';
    const defaultValue = input => /\[/.test(input.type) ? [] : input.type === 'tuple' ? input.components.map(defaultValue) : input.type.startsWith('uint') || input.type.startsWith('int') ? '0' : input.type === 'address' ? evmUi.address || '' : input.type === 'bool' ? false : '';
    evmEl('evmArgs').value = evmJson(method.inputs.map(defaultValue));
    evmBuildParameterFields('evmArgs', method.inputs);
    if (typeof updateContractGasVisibility === 'function') updateContractGasVisibility();
}
function evmUseArtifact(artifact) {
    const bytecode = typeof artifact.bytecode === 'string' ? artifact.bytecode : artifact.bytecode?.object;
    if (!Array.isArray(artifact.abi)) throw new Error('文件须包含 abi 数组');
    evmUi.artifactName = artifact.contractName || '自定义合约';
    evmEl('evmAbi').value = evmJson(artifact.abi);
    evmEl('evmBytecode').value = bytecode ? (bytecode.startsWith('0x') ? bytecode : '0x' + bytecode) : '';
    evmEl('evmConstructorArgs').value = evmJson(artifact.constructorArgs || []);
    evmEl('evmGas').value = '1000000';
    evmEl('evmContract').value = '';
    evmLoadMethods();
    evmBuildParameterFields('evmConstructorArgs', evmInterface().deploy.inputs);
    if (evmEl('artifactStatus')) { evmEl('artifactStatus').textContent = `已加载 ${evmUi.artifactName} · 尚未部署。也可在调用页填写已有合约地址。`; evmEl('deploymentCard').hidden = true; }
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
    if (!evmEl('evmContract').value.trim()) throw new Error('请先部署并查询成功回执，或填写已有合约地址');
    return { to: ethers.getAddress(evmEl('evmContract').value.trim()), data: iface.encodeFunctionData(evmEl('evmMethod').value, evmParams('evmArgs')), gasLimit, valueWei };
}
function evmEstimate(deploy) {
    return evmAction(async () => {
        if (mmMode()) { await mmEstimate(deploy); return; }
        if (!evmUi.address) throw new Error('请先选择钱包');
        const result = await evmApi('estimate', { ...evmTxOptions(deploy), gasLimit: String(evmUi.network?.transactionGasLimit || 5000000), from: evmUi.address });
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
        } else { const artifact = deploy ? evmArtifactSnapshot() : null; evmSubmitted(await evmSignAndSubmit(options), deploy ? 'deploy' : 'call', artifact); }
    });
}

async function evmSignAndSubmit(options) {
    const pem = await evmSecret(), wallet = walletCrypto.importPem(pem);
    const signer = new ethers.Wallet(walletCrypto.rawFromPem(pem));
    const source = signer.address.toLowerCase();
    const context = await evmApi('signing-context/' + source);
    const rawTransaction = await signer.signTransaction({ type: 0, chainId: context.evmChainId, nonce: Number(context.nonce),
        gasPrice: context.gasPriceWei, gasLimit: options.gasLimit, to: options.to || undefined,
        data: options.data, value: options.valueWei });
    if (context.modern) return evmApi('raw', { rawTransaction });
    const native = await api('/api/transaction/context/' + wallet.address);
    const transaction = walletCrypto.signEnvelope(pem, { kind: 'evm', chainId: native.chainId, nonce: native.nextNonce,
        to: options.to?.toLowerCase() || 'EVM_CREATE', evmAddress: source, rawTransaction });
    return evmApi('signed', { transaction });
}
