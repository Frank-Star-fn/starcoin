
# StarCoin

可视化的区块链demo。

## 快速启动

```sh
# 复制配置模板并按需修改
cp .env.example .env
# 或者直接使用默认配置启动:
node src/server.js
```

## 多节点启动

```sh
# 方式一：通过环境变量覆盖端口（会覆盖 .env 中的 PORT）
$env:PORT="3000" ; node src/server.js
$env:PORT="3001" ; node src/server.js
$env:PORT="3002" ; node src/server.js

# 方式二：直接修改 .env 文件中的 PORT 值
```

## 配置管理

项目使用 `.env` + `dotenv` 统一管理配置。

### 配置文件

- **`.env`**：实际使用的配置（已加入 `.gitignore`，不会被提交）
- **`.env.example`**：配置模板，包含所有可配置项及其说明

### 核心配置项

| 分组 | 变量名 | 默认值 | 说明 |
|---|---|---|---|
| **节点** | `PORT` | `3000` | HTTP/WS 服务端口 |
| | `SEED_PEERS` | `(空)` | 种子节点列表（逗号分隔） |
| **P2P 重连** | `P2P_RECONNECT_BASE_DELAY` | `1000` | 重连初始延迟（ms） |
| | `P2P_RECONNECT_MAX_DELAY` | `30000` | 重连最大延迟（ms） |
| | `P2P_RECONNECT_MAX_RETRIES` | `50` | 最大重试次数 |
| **P2P 心跳** | `P2P_HEARTBEAT_INTERVAL` | `15000` | 心跳间隔（ms） |
| | `P2P_HEARTBEAT_TIMEOUT` | `6000` | 心跳超时（ms） |
| **节点发现** | `P2P_DISCOVERY_INTERVAL` | `30000` | 发现间隔（ms） |
| | `P2P_DISCOVERY_MAX_PEERS` | `20` | 最大节点数 |
| **链同步** | `SYNC_TIMEOUT` | `10000` | 同步超时（ms） |
| | `SYNC_INTERVAL` | `60000` | 自动同步间隔（ms） |
| **挖矿** | `MINING_REWARD` | `50` | 矿工奖励 |
| | `MINING_COINBASE_MATURITY` | `5` | 奖励锁定期（块数） |
| **难度** | `DIFFICULTY_TARGET_TIME` | `12` | 目标出块时间（秒） |
| | `DIFFICULTY_INITIAL` | `5` | 初始难度 |

完整列表请参考 [.env.example](file:///c:/myfile/program/btc/starcoin/.env.example)。

### 配置加载优先级

环境变量 > `.env` 文件 > 代码默认值

即：通过 `$env:PORT="3000"` 设置的环境变量优先级高于 `.env` 文件中的值。

## 代码结构

前端(front)：
app.js, wallet.js, main.js, mining.js, 负责可视化和交互。

后端：
server.js, blockchain.js, difficulty-manager.js, chain-sync.js, core.js, routers目录, p2p目录, 负责处理请求和响应。

测试：
test目录, 执行单元测试。

## 已完成功能

- 多节点。支持自动重连机制。支持节点自动发现。自动检查节点同步，如果发现不同步，使用最长的那个链。更新链，造成分叉回滚时，分叉内的交易回到交易池，并且分叉链的矿工奖励回滚。使用WebSocket实时推送。通过 P2P 广播机制，在不同节点之间更新交易池。使用Merkle树。

- 动态难度调整。控制平均出块速度在12秒左右，对标Ethereum。支持浮点数难度。支持自动持续挖矿，挖矿时有动画，显示搜索过程。矿工奖励需要5个区块确认后才能使用。挖矿节点从交易池选取交易打包时，优先打包手续费最高的交易。

- 交易。交易手续费自然燃烧。支持私钥导出和导入。

- 单元测试。使用Vitest测试框架进行单元测试。

## TODO

- 添加更多单元测试。