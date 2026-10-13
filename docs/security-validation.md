# 安全修复验证（2026-10-13）

修复覆盖管理鉴权、浏览器来源与 Host 校验、P2P 消息与资源边界、存储型 XSS、可信代理限流，以及钱包本地派生和签名。完整回归使用隔离账本、测试自建服务器和临时端口，没有启动实际节点。

## 验证结果

- Vitest：53 个测试文件、868 项测试全部通过。
- TypeScript：`npm run build` 通过。
- 实际浏览器：10 条搜索/历史/列表渲染路径中恶意载荷执行次数为 0；375 像素移动端宽度下长文本无横向溢出。
- 实际浏览器钱包：创建与导入两个 HD 根、派生三个地址；9 次真实 HTTP 请求均不包含钱包秘密；原生和桥接签名通过节点验证。
- Solidity：`npm run contracts:build` 通过，Counter 和 DemoToken 产物与修复前一致。
- 官方 npm registry 全依赖审计：0 个已知漏洞（生产与开发依赖）。

## 依赖变更

| 依赖 | 修复前 | 修复后 |
| --- | --- | --- |
| express | 4.22.2 | 4.22.3 |
| ws | 8.17.1 | 8.21.0 |
| ethers | 6.16.0 | 6.17.0 |
| proxy-addr | 2.0.7 | 2.0.8 |
| body-parser | 1.20.5 | 1.20.8 |
| qs | 6.15.3 | 6.16.0 |
| vitest | 4.1.9 | 4.1.11 |
| postcss | 8.5.15 | 8.5.30 |
| nanoid | 3.3.15 | 3.3.20 |
| source-map-js | 1.2.1 | 1.2.2 |
| tmp（solc 的依赖） | 0.0.33 | 0.2.7 |

EthereumJS 保持 10.1.0，solc 保持 0.8.30。通过 override 升级 tmp，避免改变 Solidity 编译器与合约字节码；所有 ws 使用同一个已修复的版本。锁文件记录完整依赖图。

## 公告与实际入口

- [proxy-addr 公告](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h)：错误的 IPv4 映射 IPv6 信任网段可导致相信客户端转发头。默认不信任代理；显式代理配置使用修复后的解析器。
- [ws 公告](https://github.com/advisories/GHSA-96hv-2xvq-fx4p)：P2P 与前端订阅的 WebSocket 接收器可被大量小分片耗尽内存。升级并对入站、出站显式设置分片/缓存块上限，用 1025 个小分片的隔离测试验证连接关闭。
- [qs 公告](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g)：特定 parse/stringify 选项组合可让攻击者数据引起异常；更新 Express、body-parser 和测试客户端的依赖。
- [Vitest 公告](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)：主要涉及公开的开发服务器 mock 重定向入口，当前 Node 测试模式没有对外启用该入口；仍升级到修复版本。
- [tmp 公告](https://github.com/advisories/GHSA-7c78-jf6q-g5cm)：0.2.6 的路径类型绕过在 0.2.7 修复。当前 tmp 用于开发侧编译工具，HTTP/P2P 不把输入传给它。

## 使用变化

管理操作需要配置 `ADMIN_TOKEN` 并在节点页设置凭证。旧钱包秘密接口默认返回 410；本机兼容模式必须显式启用并鉴权。默认只监听本机，远程演示需要配置可信 Host、对等主机和 HTTPS 代理。完整参数见 [安全配置](security.md) 与 [OpenAPI](openapi.json)。

复验浏览器脚本为 `scripts/check-browser-security.cjs`、`scripts/check-browser-wallet.cjs`，需要通过 NODE_PATH 提供 Playwright；Windows 默认使用已安装的 Edge，可通过 BROWSER_CHANNEL 选择其他已安装浏览器。
