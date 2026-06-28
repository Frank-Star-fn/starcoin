
# StarCoin

可视化的区块链demo。

## 启动

```sh
$env:PORT="3000" ; node src/server.js
$env:PORT="3001" ; node src/server.js
$env:PORT="3002" ; node src/server.js
```

## 配置管理

- **`.env.example`**：配置模板，包含所有可配置项及其说明

## 代码结构

- 前端：front目录, 负责可视化和交互。

- 后端：server.js, difficulty-manager.js, chain-sync.js, core.js, blockchain目录, p2p目录, routers目录, middleware目录, 负责处理请求和响应。

## 已完成功能

- 交易。交易手续费自然燃烧。支持私钥导出和导入，支持助记词。支持交易搜索功能。支持cBTC和cETH，前缀c表示跨链资产（cross-chain asset）。

- 多节点。支持自动重连。支持节点自动发现。自动检查节点同步，不同步时使用最长的链。分叉回滚时，分叉内的交易回到交易池、矿工奖励回滚。使用WebSocket实时推送。通过 P2P 广播机制更新交易池。使用Merkle树。

- 动态难度调整。控制平均出块速度在12秒左右。支持浮点数难度。支持自动持续挖矿，挖矿时有动画显示搜索过程。矿工奖励需要5个区块确认后才能使用。挖矿节点优先打包手续费最高的交易。

- 单元测试。使用Vitest框架进行单元测试。

## TODO
