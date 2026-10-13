
# StarCoin

可视化的区块链demo。

## 启动

启动：

```sh
$env:PORT="3000" ; node src/server.js
$env:PORT="3001" ; node src/server.js
$env:PORT="3002" ; node src/server.js
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
