// All MetaMask signing happens in the injected provider. No secret is requested or stored.
const mmState = { provider: null, address: null, network: null, chainId: null, providers: [], listening: null };
let mmRequestId = 0;
const mmMode = () => document.getElementById('evmSigner').value === 'metamask';
const mmQ = value => '0x' + BigInt(value).toString(16);
async function mmRpc(method, params = []) {
    const response = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++mmRequestId, method, params }) });
    const data = await response.json(); if (data.error) throw new Error(data.error.message); return data.result;
}
window.addEventListener('eip6963:announceProvider', event => {
    const detail = event.detail;
    if (detail?.info?.rdns === 'io.metamask' && detail.provider?.request && !mmState.providers.includes(detail.provider)) mmState.providers.push(detail.provider);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
function mmProvider() {
    return mmState.provider || mmState.providers[0] || window.ethereum?.providers?.find(provider => provider.isMetaMask) || (window.ethereum?.isMetaMask ? window.ethereum : null);
}
function mmListen(provider) {
    if (mmState.listening === provider) return;
    mmState.listening = provider;
    provider.on?.('accountsChanged', accounts => { mmState.address = accounts[0] || null; if (mmMode()) mmRefreshWallet(); });
    provider.on?.('chainChanged', chainId => { mmState.chainId = chainId; if (mmMode()) mmRefreshWallet(); });
    provider.on?.('disconnect', () => { mmState.address = null; if (mmMode()) mmRefreshWallet(); });
}
async function mmNetwork() { mmState.network = await mmRpc('starcoin_getNetwork'); return mmState.network; }
function mmConnect() {
    return evmAction(async () => {
        const provider = mmProvider(); if (!provider) throw new Error('未检测到 MetaMask，请安装浏览器扩展');
        await mmNetwork(); const accounts = await provider.request({ method: 'eth_requestAccounts' });
        mmState.provider = provider; mmState.address = accounts[0] || null; mmListen(provider);
        document.getElementById('evmSigner').value = 'metamask'; await mmRefreshWallet();
        evmEl('evmResult').textContent = BigInt(mmState.chainId) === BigInt(mmState.network.chainId) ? 'MetaMask 已连接 StarCoin，可以转账或进行合约交互。' : 'MetaMask 已连接。请添加 / 切换到 StarCoin，再进行转账或合约写入。';
    });
}
function mmSwitchNetwork() {
    return evmAction(async () => {
        const provider = mmProvider(); if (!provider) throw new Error('未检测到 MetaMask');
        const network = await mmNetwork();
        try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: network.chainId }] }); }
        catch (error) {
            if (error.code !== 4902 && error.data?.originalError?.code !== 4902) throw error;
            await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: network.chainId, chainName: network.chainName,
                rpcUrls: [window.location.origin + '/rpc'], nativeCurrency: network.nativeCurrency }] });
            await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: network.chainId }] });
        }
        mmState.provider = provider; mmListen(provider); await mmRefreshWallet();
        evmEl('evmResult').textContent = '已切换到 StarCoin 网络。';
    });
}
async function mmGuard() {
    const provider = mmProvider(); if (!provider || !mmState.address) throw new Error('请先连接 MetaMask');
    const network = await mmNetwork(), chainId = await provider.request({ method: 'eth_chainId' });
    const accounts = await provider.request({ method: 'eth_accounts' });
    if (!accounts[0] || accounts[0].toLowerCase() !== mmState.address.toLowerCase()) throw new Error('钱包账户已改变，请重新连接');
    if (BigInt(chainId) !== BigInt(network.chainId)) throw new Error('请先添加 / 切换到 StarCoin 网络');
    return provider;
}
async function mmRefreshWallet() {
    try {
        const network = await mmNetwork(), provider = mmProvider();
        if (!mmMode()) return;
        evmEl('evmNetwork').textContent = `Chain ID ${BigInt(network.chainId)} · Shanghai · 动态 baseFee ${ethers.formatUnits(network.baseFeePerGas, 'gwei')} gwei · MetaMask`;
        if (!mmState.address) { evmUi.address = null; evmEl('evmWallet').textContent = '请连接 MetaMask'; evmEl('mmConnection').textContent = '钱包尚未授权账户'; return; }
        const selected = mmState.address, balance = await mmRpc('eth_getBalance', [selected, 'latest']), nonce = await mmRpc('eth_getTransactionCount', [selected, 'latest']);
        mmState.chainId = await provider.request({ method: 'eth_chainId' });
        if (!mmMode() || selected !== mmState.address) return;
        evmUi.address = selected;
        evmEl('evmWallet').textContent = `MetaMask · ${selected}\nEVM 余额 ${ethers.formatEther(balance)} STC · 已确认 nonce ${BigInt(nonce)}`;
        evmEl('mmConnection').textContent = BigInt(mmState.chainId) === BigInt(network.chainId) ? '已连接 StarCoin，写入操作将在 MetaMask 中确认。' : '当前钱包网络不是 StarCoin，请点击“添加 / 切换 StarCoin”。';
        if (!evmEl('evmNativeRecipient').value && state.wallets[state.selectedWallet]) evmEl('evmNativeRecipient').value = state.wallets[state.selectedWallet].address;
        if (evmEl('evmReceiptId').value) await evmReadReceipt();
    } catch (error) { if (mmMode()) evmEl('evmWallet').textContent = error.message; }
}
function mmTx(options) { return { from: mmState.address, ...(options.to ? { to: options.to } : {}), data: options.data,
    value: mmQ(options.valueWei), gas: mmQ(options.gasLimit), chainId: mmState.network.chainId }; }
function mmSubmitted(hash, kind = 'call', artifact = null) {
    evmEl('evmReceiptId').value = hash; evmEl('evmReceiptStatus').textContent = '待打包，请挖矿确认'; evmEl('evmReceiptOutput').textContent = '';
    evmEl('evmResult').textContent = '签名交易已提交：' + hash + '\n请挖矿确认，然后查询回执。'; debouncedRefreshAll('high');
    if (typeof trackContractTransaction === 'function') { trackContractTransaction(hash, kind, artifact); showContractTab('receipts'); }
}
async function mmEstimate(deploy) {
    if (!mmState.address) throw new Error('请先连接 MetaMask');
    await mmNetwork(); const tx = mmTx(evmTxOptions(deploy)); tx.gas = mmState.network.gasLimit;
    const minimum = BigInt(await mmRpc('eth_estimateGas', [tx, 'pending']));
    const limit = BigInt(mmState.network.gasLimit), buffered = minimum * 120n / 100n;
    evmEl('evmGas').value = (buffered < limit ? buffered : limit).toString();
    evmEl('evmResult').textContent = `模拟成功 · Gas ${minimum}\n已填写含 20% 余量的上限。估算无需私钥。`;
}
async function mmExecute(deploy) {
    const options = evmTxOptions(deploy), readonly = !deploy && ['view', 'pure'].includes(evmInterface().getFunction(evmEl('evmMethod').value).stateMutability);
    if (readonly) {
        const result = await mmRpc('eth_call', [{ to: options.to, data: options.data, ...(mmState.address ? { from: mmState.address } : {}) }, 'latest']);
        evmEl('evmResult').textContent = '查询结果：\n' + evmJson(Array.from(evmInterface().decodeFunctionResult(evmEl('evmMethod').value, result)));
    } else { const artifact = deploy ? evmArtifactSnapshot() : null; const provider = await mmGuard(); mmSubmitted(await provider.request({ method: 'eth_sendTransaction', params: [mmTx(options)] }), deploy ? 'deploy' : 'call', artifact); }
}
function mmTransfer() {
    return evmAction(async () => {
        const provider = await mmGuard(), to = ethers.getAddress(evmEl('mmRecipient').value.trim()), value = ethers.parseEther(evmEl('mmAmount').value.trim());
        if (value <= 0n) throw new Error('转账金额必须大于 0');
        mmSubmitted(await provider.request({ method: 'eth_sendTransaction', params: [{ from: mmState.address, to, value: mmQ(value), chainId: mmState.network.chainId }] }), 'transfer');
    });
}
async function mmWithdraw() {
    const provider = await mmGuard(), target = evmEl('evmNativeRecipient').value.trim() || state.wallets[state.selectedWallet]?.address;
    if (!target || !/^[0-9a-f]{32}$/.test(target)) throw new Error('请填写原生收款地址');
    const amount = evmEl('evmBridgeAmount').value.trim();
    const data = await mmRpc('starcoin_getWithdrawalTypedData', [{ owner: mmState.address, nativeAddress: target, amount }]);
    if (data.message.owner.toLowerCase() !== mmState.address.toLowerCase() || data.message.nativeAddress !== '0x' + target
        || data.message.amountUnits !== ethers.parseUnits(amount, 8).toString() || BigInt(data.domain.chainId) !== BigInt(mmState.network.chainId)
        || data.primaryType !== 'Withdraw' || data.domain.name !== 'StarCoin Bridge' || data.domain.version !== '1'
        || data.domain.salt !== '0x' + mmState.network.rpcConsensusHash) throw new Error('节点返回的取回授权与填写内容不一致');
    // Construct the signing schema locally, so a node cannot substitute another authorization type.
    const typed = { domain: { name: 'StarCoin Bridge', version: '1', chainId: BigInt(mmState.network.chainId).toString(), salt: '0x' + mmState.network.rpcConsensusHash }, primaryType: 'Withdraw', types: {
        EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'salt', type: 'bytes32' }],
        Withdraw: [{ name: 'owner', type: 'address' }, { name: 'nativeAddress', type: 'bytes16' }, { name: 'amountUnits', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }]
    }, message: { owner: mmState.address, nativeAddress: '0x' + target, amountUnits: ethers.parseUnits(amount, 8).toString(), nonce: data.message.nonce, deadline: data.message.deadline } };
    const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [mmState.address, JSON.stringify(typed)] });
    mmSubmitted(await mmRpc('starcoin_submitWithdrawal', [{ message: data.message, signature }]), 'withdraw');
}
async function mmReceipt(hash) {
    const receipt = await mmRpc('eth_getTransactionReceipt', [hash]);
    if (!receipt) {
        const bridge = await mmRpc('starcoin_getWithdrawalReceipt', [hash]);
        if (bridge.status !== 'unknown') return bridge;
        const tx = await mmRpc('eth_getTransactionByHash', [hash]);
        return { id: hash, status: tx ? 'pending' : 'unknown', confirmations: 0 };
    }
    const height = BigInt(await mmRpc('eth_blockNumber'));
    return { ...receipt, id: hash, status: Number(BigInt(receipt.status)), gasUsed: BigInt(receipt.gasUsed).toString(),
        confirmations: Number(height - BigInt(receipt.blockNumber) + 1n), feeWei: (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)).toString() };
}
function mmWatchToken() {
    return evmAction(async () => {
        const provider = await mmGuard(), address = ethers.getAddress(evmEl('evmContract').value.trim());
        const iface = new ethers.Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
        const [symbol, decimals] = await Promise.all(['symbol', 'decimals'].map(async name => {
            const result = await mmRpc('eth_call', [{ to: address, data: iface.encodeFunctionData(name) }]); return iface.decodeFunctionResult(name, result)[0];
        }));
        const accepted = await provider.request({ method: 'wallet_watchAsset', params: { type: 'ERC20', options: { address, symbol, decimals: Number(decimals) } } });
        evmEl('evmResult').textContent = accepted ? 'ERC20 已导入 MetaMask：' + symbol : '已取消导入代币';
    });
}
