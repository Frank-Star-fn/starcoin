
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

- 前端(front目录)：app.js, wallet.js, main.js, mining.js, 负责可视化和交互。

- 后端：server.js, blockchain.js, difficulty-manager.js, chain-sync.js, core.js, routers目录, p2p目录, 负责处理请求和响应。

- 测试：test目录, 执行单元测试。

## 已完成功能

- 多节点。支持自动重连。支持节点自动发现。自动检查节点同步，不同步时使用最长的链。更新链，造成分叉回滚时，分叉内的交易回到交易池，并且分叉链的交易和矿工奖励回滚。使用WebSocket实时推送。通过 P2P 广播机制更新交易池。使用Merkle树。

- 动态难度调整。控制平均出块速度在12秒左右，对标Ethereum。支持浮点数难度。支持自动持续挖矿，挖矿时有动画，显示搜索过程。矿工奖励需要5个区块确认后才能使用。挖矿节点从交易池选取交易打包时，优先打包手续费最高的交易。

- 交易。交易手续费自然燃烧。支持私钥导出和导入。支持交易搜索功能。

- 单元测试。使用Vitest测试框架进行单元测试。

## TODO
