# Ethereum JSON-RPC 与 MetaMask

节点提供 `POST /rpc`，例如 `http://localhost:3000/rpc`。请求使用 JSON-RPC 2.0；支持最多 20 项的批量请求，无 `id` 的通知返回 HTTP 204。请求体上限 1 MB，批量中的每项分别计入读写限流。REST API 仍使用 `/api`，参数见 [OpenAPI](openapi.json)。

## 网络与升级

默认网络：`StarCoin`，chainId `155001`（`0x25d79`），货币 `STC`，18 位小数，Shanghai 执行规则。MetaMask 可通过页面“添加 / 切换 StarCoin”按钮添加网络；也可在扩展中填写节点的 `/rpc` URL、chainId 和符号。使用可信节点 URL。

已有网络升级须先停止所有节点与挖矿，备份 `data`，在完整节点执行 `npm run metamask:prepare`，然后将相同的 `data/evm-network.json` 和 `data/metamask-network.json` 分发到所有机器，重启全部节点再挖矿。工具审计历史链并固定升级检查点；历史区块不改写。首次载入保留 `.pre-metamask.json`，新存档版本为 6.0。空节点先复制两份网络配置，再启动并同步。全新网络直接启动即可。

v4 协议接受 type 0（EIP-155 legacy）、type 1（EIP-2930）和 type 2（EIP-1559）原始签名交易，验证签名、chainId、nonce、余额及 Gas。签名由钱包完成，`eth_sendRawTransaction` 不需要 PEM、公钥封装或原生 STC 账户。交易池只接受连续 nonce；相同地址和 nonce 的替换交易要求费用上限和优先费均提高至少 10%，并严格高于旧值。取消交易可使用相同 nonce 向自己转账并提高费用。入块后的 REVERT/OOG 交易状态为 `0x0`，仍扣 Gas 并消耗 EVM nonce。

baseFee 初始为 10 gwei，以区块 Gas 上限的一半为目标，按 EIP-1559 公式调整。建议优先费默认 1 gwei。legacy/access-list 的 gasPrice 必须覆盖 baseFee；type 2 的 maxFeePerGas 必须覆盖 baseFee。实际费用为 `gasUsed × effectiveGasPrice`，所有费用包括优先费都燃烧。

## 方法

| 类别 | 支持的方法 |
| --- | --- |
| 网络 | `eth_chainId`、`net_version`、`net_listening`、`web3_clientVersion`、`web3_sha3`、`eth_syncing`、`eth_blockNumber` |
| 账户 | `eth_accounts`（空数组，节点不管理签名账户）、`eth_coinbase`、`eth_getBalance`、`eth_getTransactionCount`、`eth_getCode`、`eth_getStorageAt` |
| 区块 | `eth_getBlockByNumber`、`eth_getBlockByHash`、`eth_getBlockTransactionCountByNumber/Hash`、`eth_getTransactionByBlockNumberAndIndex`、`eth_getTransactionByBlockHashAndIndex`、`eth_getUncleCountByBlockNumber/Hash` |
| 交易与合约 | `eth_sendRawTransaction`、`eth_getTransactionByHash`、`eth_getTransactionReceipt`、`eth_call`、`eth_estimateGas`、`eth_getLogs` |
| 费用 | `eth_gasPrice`、`eth_maxPriorityFeePerGas`、`eth_feeHistory` |
| StarCoin | `starcoin_getNetwork`、`starcoin_getBridgeNonce`、`starcoin_getWithdrawalTypedData`、`starcoin_submitWithdrawal`、`starcoin_getWithdrawalReceipt` |

Ethereum 数量使用规范十六进制字符串（零为 `0x0`，不允许 `0x00`）；地址为 20 字节 `0x…`，交易哈希为原始 Ethereum 交易的 Keccak-256。账户查询、call、estimate 支持 `latest`、`pending`、`earliest` 和十六进制区块高度，也支持 `{blockHash, requireCanonical}` 或 `{blockNumber}` 选择器；只读取当前主链。默认账户查询/call 使用 latest，estimate 使用 pending，模拟不会改变链或交易池。

交易对象支持 `from`、`to`、`data`/`input`、`value`、`gas`、`gasPrice` 或 `maxFeePerGas`/`maxPriorityFeePerGas`、`accessList`、`type`。Gas 单笔默认上限 5000000，区块上限 30000000；估算无需私钥，提供 from 时检查该地址的可支付额度。交易池状态及费用变化可能影响最终执行。

待打包交易的回执为 `null`；回执包含 status、gasUsed、effectiveGasPrice、contractAddress、logs 和确认区块。重组后孤块回执变为 `null`，孤块日志不会出现在 `eth_getLogs` 中。重组交易重新校验后可能回到交易池。确认数由最新高度与回执 blockNumber 计算；StarCoin 采用 PoW，前端通常等待多次确认。

日志查询支持地址数组、最多四个位置的 topic（null 为通配，同位置数组为 OR）、区块范围或单个 blockHash。高度跨度最多 2000，结果最多 10000 条。feeHistory 最多 1024 个区块及 20 个升序百分位，返回各块 baseFee、Gas 比例和按 Gas 加权的优先费。

```json
{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}
```

```json
{"jsonrpc":"2.0","id":2,"method":"eth_getBalance","params":["0x0000000000000000000000000000000000000001","latest"]}
```

```json
{"jsonrpc":"2.0","id":3,"method":"eth_estimateGas","params":[{"from":"0x0000000000000000000000000000000000000001","to":"0x0000000000000000000000000000000000000002","value":"0x1"},"pending"]}
```

常见错误：`-32700` JSON 解析错误，`-32600` 请求错误，`-32601` 方法未实现，`-32602` 参数错误，`-32000` 节点拒绝交易/状态查询，`-32005` 超出限流。合约模拟失败使用 code `3`，data 中保留 revert 返回字节。

## STC 存入与签名取回

原生 STC 账户（16 字节地址、8 位小数）与 EVM STC（20 字节地址、18 位小数）分别记账。MetaMask 只显示 EVM 余额。通过页面选择本地原生钱包，指定 MetaMask 的 EVM 地址并“存入 EVM”，挖矿确认后才能支付 EVM value 和 Gas；ERC20 余额属于合约存储。

取回无需将 MetaMask 私钥交给页面或节点：

1. 调用 `starcoin_getWithdrawalTypedData`，参数为 `[{owner, nativeAddress, amount, deadline?}]`。owner 为 EVM 地址，nativeAddress 为不带 `0x` 的 32 位小写十六进制原生地址，amount 为最多八位小数的 STC 字符串；deadline 可选，为十六进制 Unix 秒，默认 30 分钟。
2. 检查返回的收款地址、amountUnits、nonce、deadline 与 domain，在 MetaMask 内调用 `eth_signTypedData_v4` 签署。
3. 调用 `starcoin_submitWithdrawal`，参数为 `[{message, signature}]`，得到带 `0x` 的 StarCoin 交易 ID。挖矿后通过 `starcoin_getWithdrawalReceipt` 查询状态；这类授权不属于 Ethereum 交易，`eth_getTransactionReceipt` 返回 null。

授权 domain 为 `StarCoin Bridge`、version `1`、EVM chainId，以及 MetaMask 共识配置指纹作为 salt。Withdraw 消息绑定 owner、bytes16 nativeAddress、原生最小单位 amountUnits、独立取回 nonce 和截止时间。节点重新构造 domain/types 并验证签名，拒绝篡改、跨网络、过期和重复授权。`starcoin_getBridgeNonce(owner, tag?)` 返回授权 nonce，不占用 `eth_getTransactionCount`。无法整除 `10^10 wei` 的零头留在 EVM。

## 兼容范围

支持 MetaMask 网络连接、STC 转账、Shanghai 合约部署/读写、ERC20 导入，以及 ethers JSON-RPC 客户端。钱包交互 `eth_requestAccounts`、`eth_sendTransaction`、`eth_signTypedData_v4`、`wallet_addEthereumChain`、`wallet_switchEthereumChain` 和 `wallet_watchAsset` 由浏览器扩展处理，节点接收最终原始交易或授权签名。

StarCoin 仍使用自己的 PoW 区块、原生交易和 SHA-256 区块哈希。RPC 返回对应主链区块的视图；transactionsRoot/receiptsRoot 是 StarCoin 的原生承诺，不能用于验证 Ethereum 区块头或 Ethereum 交易/回执证明。EVM stateRoot 使用 EthereumJS 状态树。RPC 中交易列表只包含 Ethereum 交易，不包含原生转账与资金存取。

当前没有 WebSocket Ethereum 订阅、filter API、trace/debug、账户解锁/节点代签、`eth_getProof`、safe/finalized 标签、blob 交易或 EIP-7702。合约须编译为 Shanghai 目标。MetaMask 的高级账户功能及依赖这些接口的应用暂不支持；钱包中使用普通账户与标准交易。
