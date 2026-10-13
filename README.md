
# StarCoin

可视化的区块链demo。

## 启动

启动：

```sh
npm install
npm run start:node1
npm run start:node2
```

从浏览器进入：

```sh
http://localhost:3000/
```

## 配置管理

- **`.env.example`**：配置模板，包含所有可配置项及其说明

## API 文档

简洁的 OpenAPI 3.0 文档位于 [docs/openapi.json](docs/openapi.json)。启动服务后访问 [http://localhost:3000/api/openapi.json](http://localhost:3000/api/openapi.json)，可下载或导入支持 OpenAPI 的 API 工具查看。文档使用相对基址 `/api`，在其他节点端口也可访问。

文档覆盖当前 HTTP API 的主要参数、响应和错误，包括 HD 钱包、交易确认状态以及 SSE 挖矿流。`GET /api/mine/stream` 会启动挖矿；重置链、清空交易池等操作会修改节点数据。更新路由时同步更新文档，运行 `npm test` 校验规范格式和路由覆盖。

## 代码结构

- 前端：front目录, 负责可视化和交互。

- 后端：server.js, difficulty-manager.js, chain-sync.js, core.js, blockchain目录, p2p目录, routers目录, middleware目录, 负责处理请求和响应。

## 已完成功能

- 交易。手续费自然燃烧。支持私钥/助记词导出和导入。支持搜索链上交易。支持cBTC和cETH，前缀c表示跨链资产（cross-chain asset）。

- HD 钱包。一组助记词管理多个子地址，支持地址派生、完整备份和恢复，兼容旧版单地址钱包。

- 多节点。支持自动重连。支持节点自动发现。自动检查节点同步，不同步时使用最长的链。分叉回滚时，分叉内的交易回到交易池、矿工奖励回滚。使用Merkle树。

- 动态难度调整。控制平均出块速度在12秒左右。支持自动持续挖矿。矿工奖励需要5个区块确认后才能使用。挖矿节点优先打包手续费最高的交易。

- 单元测试。使用Vitest框架。

## HD 钱包

点击“创建 HD 钱包”生成英文 BIP39 助记词及第一个地址，在钱包分组内点击“新增地址”继续派生。每个子地址可独立查询 STC、cBTC、cETH 余额、转账及接收矿工奖励。第一版固定账户 0、接收分支 0，使用 BIP32/secp256k1 和路径 `m/44'/1'/0'/0/i`；`1'` 是 demo 的测试币种命名空间。公钥、地址和签名仍使用项目原有格式，这些地址不是比特币或以太坊地址。

“完整备份”下载 `starcoin_hd_*.json`，包含助记词、BIP39 密码（如有）、派生方案、地址名称和下一个地址索引。文件包含控制钱包的秘密，请离线保管。点击“恢复 HD 备份”可以恢复已创建但尚未使用的地址，并保留删除地址后的索引进度。导出某个子地址的 `.pem` 只备份该地址，无法恢复整个 HD 钱包。

只有助记词时，点击“导入助记词”，选择“HD 钱包”，填写创建时使用的 BIP39 密码；没有密码时留空。恢复根据链上历史交易（包括已花完余额的地址和矿工奖励）及交易池发现地址，连续 20 个地址未使用时停止；每次请求最多扫描 200 个地址。“继续扫描”从上次结束的位置继续，可以跨过较大的空白间隔。助记词恢复无法自动找回未使用地址的名称和原来的分配进度，完整 JSON 备份保留这些信息。

旧版“生成新钱包”和旧助记词接口保留原算法。恢复旧助记词时选择“旧版单地址钱包”，恢复结果与升级前一致。BIP39 密码会影响钱包和地址，必须与原值一致。浏览器持久化格式升级为 version 3，可加载原来的 v1/v2 数据；助记词、密码和子地址私钥通过 AES-GCM 加密，浏览器加密密钥保存在 IndexedDB。解密失败时保留原始加密记录。

HD 功能沿用此 demo 的后端生成、派生和交易签名方式：助记词在创建、导入、派生请求中经过后端，子地址私钥用于原有转账接口；后端不会持久化 HD 根密钥。浏览器本地加密不能代替对所连接节点的信任。

### HD API

| 接口 | 请求 | 返回 |
| --- | --- | --- |
| `POST /api/wallet/hd/new` | 可选 `strength`（128/256）、`passphrase` | `mnemonic`、`root`、首个子地址 `wallets`、`nextIndex` |
| `POST /api/wallet/hd/derive` | `mnemonic`、可选 `passphrase`，以及 `startIndex`、`count`（1–100）；或 `indices`（1–100 个索引） | `root`、`wallets`、`nextIndex` |
| `POST /api/wallet/hd/import` | `mnemonic`、可选 `passphrase`、`startIndex`、`scanCount`（20–200） | 已发现的 `wallets`、`nextIndex`、`scanNextIndex`、`stoppedAtGap`、`exhausted` |

接口可传 `scheme: "bip44-v1"` 和 `basePath: "m/44'/1'/0'/0"`，其他派生方案拒绝导入。所有地址索引须是 0 到 2147483647 之间的整数。HD API 响应禁止缓存，后端仅在请求期间使用根密钥。

验证：`npm test`，编译：`npm run build`。HD 测试覆盖 [BIP32 官方测试向量](https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki)、旧助记词固定地址、子地址交易、恢复扫描、备份往返及存储迁移。

## EVM 智能合约

基于 [EthereumJS VM](https://github.com/ethereumjs/ethereumjs-monorepo/tree/master/packages/vm) 10.1.0，固定使用 Shanghai 规则和 EIP-155 签名的 legacy Ethereum 交易。支持合约部署、调用、STC value 转账、合约存储、事件日志和回执。现有钱包的 secp256k1 私钥同时控制原生 16 字节地址和标准 20 字节 EVM 地址，两个地址分别记账。HD 子地址可以直接使用。

### 首次升级已有网络

1. 停止所有节点和自动挖矿，保留 `.env` 中原生链的共识参数，并备份 `data` 目录。
2. 安装依赖，在保存了该网络完整链的机器运行 `npm run evm:prepare`。工具审计 `data/blockchain_<port>.json`，选取累计工作量最高的有效链，生成 `data/evm-network.json`，固定激活高度、检查点、EVM chainId 和执行规则。不会改写原链文件。
3. 本机各端口共用这一配置；跨机器节点须复制相同的 `evm-network.json` 到各自 `data` 目录。新加入已有网络的空节点也须先复制配置，再启动并同步完整链。
4. 重启全部节点，例如 `npm run start:node1`、`npm run start:node2`。首次加载旧存档时自动保留 `<链文件>.pre-evm.json`。所有节点升级后再恢复挖矿。

全新网络可直接启动，默认从高度 1 激活；没有配置文件时服务会执行同样的准备流程。已有网络请先统一准备配置，避免不同机器各自选择检查点。升级后的区块使用 v3，历史区块哈希、原生余额和 nonce 保持原值。过了检查点仍生产 v2 区块的旧节点会被拒绝。已迁移网络禁止重置到检查点之前。

`EVM_CHAIN_ID` 默认 `155001`；配置生成后不得单独修改。每块默认最多 30000000 Gas，每交易最多 5000000 Gas，固定 Gas 价格 10 gwei。执行规则写入配置指纹，节点参数不一致时无法采用对方的 v3 链。开发模式和 `npm run start:prod` 使用同一份 `data` 和页面文件；生产模式先运行 `npm run build`。

### 页面使用

在“EVM 智能合约”面板选择已创建的钱包：

1. 等待矿工奖励成熟，填写 STC 金额，点击“存入 EVM”，然后挖矿确认。EVM 余额用于 value 和 Gas。
2. 点击“Counter 示例”或“ERC20 示例”，或导入包含 `abi`、`bytecode` 的合约 JSON。可展开编辑 ABI 和 creation bytecode。ERC20 示例默认发行 100 万 SDT，构造参数使用最小单位的整数字符串。
3. 估算部署 Gas，点击“部署合约”，挖矿后查询回执，合约地址自动填入。
4. 选择 ABI 方法，使用 JSON 数组填写参数，例如 Counter 的 `set(uint256)` 填 `["42"]`。大整数须加引号，地址使用 `0x` 开头的 EVM 地址。view/pure 方法直接查询；其他方法提交交易后挖矿确认。
5. 回执显示执行状态、Gas、确认数和事件日志；“取回原生账户”把当前钱包的 EVM STC 转回其原生地址，同样需要打包。

源码位于 `contracts/Counter.sol`、`contracts/DemoToken.sol`；`npm run contracts:build` 使用固定 solc 0.8.30、`evmVersion: "shanghai"` 生成 `public/contracts/*.json`。自编译合约也须指定 Shanghai，参考 [Solidity 编译目标说明](https://docs.soliditylang.org/en/v0.8.30/using-the-compiler.html#setting-the-evm-version-to-target)。ERC20 余额属于合约存储，与原生 cBTC/cETH 分开。

### 资金与确认规则

原生 STC 最小单位是 `10^-8 STC`，EVM 使用 `10^-18 STC` 的 wei。存入和取回通过签名的链上交易完成，内部使用 BigInt 精确换算；取回最多八位小数，更小的 wei 留在 EVM。所有 Gas 费用燃烧。REVERT 和 out-of-gas 是已入块的失败执行：合约/value 状态回滚，Gas 扣除，原生和 EVM 交易 nonce 仍递增。

v3 区块哈希包含 EVM 状态根、回执承诺和 Gas，接收节点重新执行交易验证。重启从区块重放代码、余额和存储；分叉切换恢复对应状态，回滚交易重新校验后回池，旧分支日志不再返回。只读调用及 Gas 估算使用已确认状态的副本，估算后状态变化仍可能影响实际执行。当前通过 REST API 使用，尚未提供完整 Ethereum JSON-RPC 或 MetaMask 接入。

此 demo 沿用后端签名方式，合约写入和估算请求会把 PEM 私钥发送到所连接的节点；浏览器复用现有加密钱包存储，后端不持久化私钥。

### EVM API

详细参数和响应见 [OpenAPI 文档](docs/openapi.json)。所有 `valueWei`、EVM 余额和 nonce 用十进制字符串传输。

| 接口 | 用途 |
| --- | --- |
| `GET /api/evm/status` | 网络规则、状态根、衔接资金和已燃烧 Gas |
| `POST /api/evm/address` | 用 SPKI `publicKey` 计算 EVM 地址 |
| `GET /api/evm/account/:address` | 已确认余额、nonce、代码 |
| `GET /api/evm/storage/:address/:slot` | 32 字节存储槽，slot 用十进制字符串 |
| `POST /api/evm/deposit`、`POST /api/evm/withdraw` | `privateKey`、八位小数 `amount`，可指定接收地址 |
| `POST /api/evm/transaction` | `privateKey`、`data`、可选 `to`、`valueWei`、`gasLimit`；不传 to 表示部署 |
| `POST /api/evm/call` | `to`、`data`、可选 `from`、`valueWei`、`gasLimit`，无需私钥 |
| `POST /api/evm/estimate` | 用与 transaction 相同参数估算 Gas，需要已确认 EVM 余额 |
| `GET /api/evm/receipt/:id` | 用 StarCoin 原生交易 ID 查询回执；包含对应 Ethereum transactionHash |
| `GET /api/evm/logs` | 当前主链事件，支持 fromBlock/toBlock/address/topic 过滤 |

验证覆盖真实 Solidity 合约、失败执行、精确资金换算、错误状态根、签名/nonce、防重放、持久化失败、重启、分叉回滚、历史升级和多节点 WebSocket 同步。
