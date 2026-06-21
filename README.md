
# StarCoin

区块链demo

## 启动节点

```sh
cd c:\myfile\program\btc\starcoin ; $env:PORT="3000" ; node server.js
cd c:\myfile\program\btc\starcoin ; $env:PORT="3001" ; node server.js
```

## 已完成功能

- 可视化。在一个网页上，可以看到所有节点的信息。可以直接在浏览器里面转账​。
- 多节点。连接节点后，让所有节点的情况相同。允许主动断开和某个其他节点的连接。
- 同步。和其他节点检查同步，如果发现不同步，使用最长的那个链。更新链，造成分叉回滚时，分叉内的交易回到交易池，并且分叉链的矿工奖励回滚
- 交易。创建转账交易时，使用私钥。允许没有交易的时候，也能打包挖矿​。交易手续费自然燃烧。

## 待增加功能

- 交易池跨节点广播（新增 TRANSACTION 消息）	server.js	⭐ 不广播=单机币
- 节点自动发现 + 重连机制	server.js	⭐ 节点网络无法自维持
- 动态难度调整	blockchain.js Blockchain	⭐ 算力变化后出块速度失控
- 区块包含 Merkle 根 + 交易存在性证明	blockchain.js Block	⭐ 无法支持轻节点
- POST /api/mine (改进)	挖矿节点从交易池选取交易打包，而不是手动写交易文本
