# 节点安全配置

交易池默认最多 1000 笔、JSON 数组最多 8 MiB、每个发送地址最多 100 笔，可通过 `MEMPOOL_MAX_TXS`、`MEMPOOL_MAX_BYTES`、`MEMPOOL_MAX_PER_ADDRESS` 配置。原生、EVM 和 P2P 入池共用这些本地限制；重启及回滚时也会限制重建后的交易池，并记录容量拒绝原因。限制不影响有效区块的共识验证。满池提交返回 HTTP 429 和具体容量错误码；单笔交易超过 P2P 分页容量返回 HTTP 413；RPC 对应返回 -32005，`data.code` 给出具体原因。

交易池同步按笔数和实际 UTF-8 字节数分页，单页最多 1 MiB 且低于 `P2P_MAX_PAYLOAD`，接收端合并后才请求下一页。分页期间交易池变化会重新开始有限次数；链下载期间暂停交易池分页。可以完整接收旧格式的小交易池消息；旧节点只会收到超限交易池的第一页，需要升级才能继续分页。

HTTP/WS 默认监听 `127.0.0.1`。跨机器演示需显式设置 `HOST`，并将实际域名或 IP 添加到 `HTTP_ALLOWED_HOSTS`；远程浏览器部署通过 HTTPS 反向代理。

限流统一使用 Express 根据可信代理配置计算的客户端 IP，不直接读取 `X-Forwarded-For` 或 `X-Real-IP`。`TRUSTED_PROXIES` 默认留空；仅填写实际代理的 IP/CIDR。代理必须覆盖外部请求的 `X-Forwarded-For`、`X-Forwarded-Host` 和 `X-Forwarded-Proto`。IPv6 及 IPv4 映射地址归一化后计数，REST/RPC 客户端计数器均有容量上限。

设置随机长字符串 `ADMIN_TOKEN` 才能启用挖矿、存储操作、手动同步、节点连接和发现控制。请求使用 `Authorization: Bearer <token>`。凭证不放进 URL，前端节点页输入的凭证只存在当前页面内存，刷新后需要重新输入。管理请求校验 Host、Origin 和浏览器来源。

`POST /api/mine/start` 创建一个任务并返回 `jobId`，`GET /api/mine/stream?jobId=...` 只订阅进度，`POST /api/mine/stop` 用 `{ "jobId": "..." }` 停止任务。三个接口均需要管理凭证。每个节点同一时刻只有一个挖矿任务，SSE 连接默认最多 8 个，十分钟后自动断开。订阅断开不会自动停止任务；前端停止按钮发送显式停止请求。

钱包生成、导入、BIP39/BIP32 派生、原生 ECDSA 和 EVM 签名在浏览器完成。浏览器只发送公开模拟参数、已签名原生交易、v3 桥接封装或 Ethereum 原始交易。旧地址、派生路径、HD 根标识、加密存储和备份保持兼容。客户端 API 层会拒绝带 `privateKey`、`privateKeyPem`、`mnemonic`、`passphrase` 或 `password` 字段的请求。

旧 `/wallet/*`、`POST /transaction`、`/evm/deposit`、`/evm/withdraw`、`/evm/transaction` 默认返回 410。仅 `LEGACY_WALLET_API=true`、本机直连且通过管理鉴权时可用；带代理转发头的请求仍拒绝。`/evm/estimate` 默认使用公开 `from`，带私钥的旧请求受相同限制。这些兼容接口响应均禁止缓存。

日志在所有传输器前脱敏秘密字段、PEM、Bearer 凭证和秘密查询参数。HTTP 错误不回显 JSON 请求体片段或堆栈。

公开链查询和已签名交易广播不需要管理凭证。链数据可以含有旧版本接受的任意地址文本，浏览器必须始终把它当作文本显示。

新提交的原生交易地址必须是 32 位小写十六进制字符串。这个 HTTP 输入策略不修改历史链的共识校验。搜索、区块列表和钱包历史使用文本节点与事件监听器；其余 HTML 模板中的外部文本进行 HTML 转义。恶意地址、备注和备份标签都不能成为 HTML 或 JavaScript。

P2P 入站、出站、发现连接共用消息校验和异常边界，拒绝畸形 JSON、未知消息类型、二进制消息和超限输入。默认单条消息不超过 4 MiB，最多 10000 个区块或 1000 笔交易，每连接十秒内最多 120 条消息，处理队列最多 8 条。超限关闭对应连接；这些是本地资源限制，不改变历史共识规则。

`P2P_ALLOWED_HOSTS` 控制允许连接和发现的主机，默认只有本机。节点 URL 只接受无凭证、无查询参数的 `ws://host:port/` 或 `wss://host:port/`，不跟随重定向。浏览器不能连接 P2P 路径 `/`；前端 `/ws` 只允许可信同源订阅，不能发送节点消息。连接总数、握手频率及节点发现队列均有上限。

WebSocket 接收器还限制每条消息最多 1024 个分片、最多 4096 个缓存块，入站与出站均生效。单个连接不能不断更换 NODE_INFO 宣告地址，重连队列也受连接数量上限约束。CHAIN_LENGTH 响应不会再触发相互应答循环。
