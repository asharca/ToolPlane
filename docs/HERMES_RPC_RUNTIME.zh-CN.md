# 已退役的 Hermes RPC 运行时

> **English**：[HERMES_RPC_RUNTIME.md](./HERMES_RPC_RUNTIME.md)

`hermes-rpc` 只保留为历史数据，不再作为可执行的 Agent 运行时。新建和继续执行 Agent 均只允许 `pi-sdk`，并要求持久化会话固定完整、已发布的修订。Hermes RPC 安装器、驱动、bootstrap 和执行回退已移除。

## 历史会话

- 保留已有消息、文件卷和原生状态作为历史记录；不把它们导入 Pi 会话，也不重放消息伪造连续状态。
- 历史 Conversation 和 Work DTO 为只读。文件从实际绑定的存储读取，停止的卷也可读取；绝不回退到当前 Agent 模板。
- 历史会话不支持终端、上传、写入、删除、恢复执行、模型选择或压缩。可执行 Pi 会话的压缩使用真实原生 `/compact` 命令。
- 普通停止保留数据卷。明确授权的删除是独立的破坏性操作；退役本身不授权删除。

## 新执行

创建 Pi Agent，只复制可转换的配置，明确重新授权能力，并发布完整修订。每个 Conversation 或委派 A2A context 固定自己的修订，按该不可变环境惰性创建独立、持久化沙箱。新会话不恢复旧 Hermes 状态。

模型和工具操作使用固定能力范围与当前授权的交集。包版本、凭据和 MCP 授权被撤销后，工具产生副作用前即失败。MCP sidecar 按会话隔离，停止会话时一并停止，但不删除工作卷。

已退役的 Agent-runtime MCP 和 dashboard 端点返回 HTTP 410。旧公共执行 API 同样退役；保留历史并不意味着旧端点映射为新的 Pi 执行入口。外部客户端必须按新范围重新登记，不能复用旧令牌。

参见 [Agent 运行时](./AGENT_RUNTIMES.zh-CN.md)与[运行时运维](./RUNTIME_OPERATIONS.zh-CN.md)。本次切换不授权重启生产、迁移生产数据或删除保留卷。
