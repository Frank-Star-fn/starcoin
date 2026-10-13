# 离线恢复与 v2 激活

恢复采用所有节点共同、严格审计通过的第 0～60 块，第 61 块激活 v2。历史区块哈希、交易和签名保持不变。后续旧区块、奖励和资产发行不作为恢复余额的依据。

## 操作流程

1. 核对每个运行节点的 `/api/storage/status` 指向本项目的数据文件，导出 `/api/blockchain` 和 `/api/mempool`，备份数据及 .env，再停止节点。只停止已核实属于本项目的进程。
2. 运行 `node scripts/migrate-chain.js prepare <项目目录> 60 <批次ID> [交易池导出目录]`。导出目录使用 `mempool-3000.json` 等文件名，每份包含 transactions 数组。
3. 查看 `data/migrations/<批次ID>/balance-diff.json`、`recovery-transactions.json` 和 `issuance-review.json`。工具会保存所有节点来源、重复记录和签名检查结果，恢复清单里的交易不进入有效交易池。
4. 运行 `node scripts/rehearse-migration.js data/migrations/<批次ID>/manifest.json`。演练使用不连接外部节点的文件副本，执行奖励成熟、v2 签名转账、三节点同步、重启与旧链拒绝检查。测试钱包密钥只在内存中使用。
5. 所有节点停止且演练通过后，运行 `node scripts/migrate-chain.js apply data/migrations/<批次ID>/manifest.json`。工具检查原文件、备份和候选校验值，验证前缀和配置，逐个替换文件并记录执行日志。写入或加载失败时恢复原始文件，保持节点停止。
6. 运行 `node scripts/migration-runtime.js start <manifest.json>`。它只在所有端口离线、切换日志完整且配置与链验证通过时后台启动本项目节点，记录 PID 和日志。三节点互联后，独立重算链工作量、余额、锁定奖励、nonce，核对 API、共识摘要和落盘文件。
7. 运行 `node scripts/migration-runtime.js activate <manifest.json>`。此命令仅允许恢复高度、空交易池的网络生成首个 v2 区块，奖励支付给保留历史最后一块的原矿工地址。验证三节点同步，并通过真实 P2P 连接重发旧无效长链、第 61 块重复的用户交易和一笔待恢复旧交易，确认账本及交易池不变。
8. 核实运行记录中的 PID、可执行文件和项目路径，停止这三个节点，再运行 start 重启。运行 `node scripts/migration-runtime.js verify <manifest.json>` 核对重启后的状态。已有新块时不能重复 activate；后续只读核验使用 verify，重放拒绝复核使用 replay。

项目路径含空格时给命令参数加引号。端口检查需要访问本机网络，受限沙箱无法访问时不能把 EACCES 当作节点已停止。

## 产物与保护

每个批次包含 backup、candidate、manifest.json、journal.json、三份核对清单和 rehearsal-report.json。启动与验收另外生成 runtime.json、logs、verification-before.json、verification-activation.json、verification-replay.json、verification-startup.json、verification-latest.json。backup 中链文件和 original.env 为原始字节副本；manifest 中记录 SHA-256。所有运行数据位于 Git 忽略的 data 目录，配置和备份不进入代码提交。

切换期间节点离线。多个文件无法在文件系统层同时替换，工具通过校验、执行日志和失败恢复保证协调切换。进程在切换中断时，应保持所有节点停止，依据 journal 状态执行备份恢复或重新准备。不要直接启动处于部分切换状态的节点。

尚未产生新链数据时，可运行 `node scripts/migrate-chain.js rollback <manifest.json>` 恢复备份。原历史仍不符合 v2 验证，因此恢复后也保持节点停止。已经生成新块或修改配置时，工具拒绝无审计覆盖，防止丢失新交易。

## 后续交易与资产

旧用户交易按 ID 去重，排除保留历史中已经确认的交易。有效旧签名仅证明原交易授权存在。恢复后的支付意图、余额、nonce 和费用必须重新核对，发送方通过自己的钱包生成 v2 签名再提交。系统不会读取钱包私钥或自动再次支付。

`fundedNow` 只是按恢复时余额对单笔交易做的检查，不预留资金，不保证全部候选可同时执行。多个转账依赖、同地址 nonce 顺序及后续余额变化由正常入池验证处理。

cBTC/cETH 支付标记为 issuance_review_required。对应旧 SYSTEM 发行记录单独保留，不能直接作为有效余额或矿工奖励。若需恢复这些资产，必须明确发行授权及数量，设计可验证的发行规则，再做协议升级。

第 61 块之后的旧原生奖励全部回滚。恢复网络的新奖励只由通过 PoW 与奖励规则验证的新区块产生。原钱包地址和密钥不改变。
