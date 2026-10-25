# 历史 Hermes Agent 存储

> **English**：[HERMES_AGENT_RUNTIME.en.md](./HERMES_AGENT_RUNTIME.en.md)

托管 `hermes` Agent 已退役，只保留只读历史。Agent 执行只允许固定修订的 `pi-sdk`。Hermes 运行时创建、配置投影、Profile/模型修改、镜像升级、dashboard、原生聊天与 Work 提交、自动启动恢复均已移除。

## 保留的资源链

已有 `Agent → AgentRuntime → Sandbox → Deployment` 数据行及其 Docker 卷保留为历史存储。历史读取使用会话实际绑定的沙箱；没有会话沙箱时，只能使用该 Agent 实际保留的旧运行时关联。绝不从新选择的模板读取文件，也不替换为其他会话的沙箱。

旧容器停止时仍可列出、读取和下载历史文件。读取使用有界辅助容器，将保留卷只读挂载，不启动 Hermes。不支持终端和文件修改。旧 Agent 级附件、终端 API，以及运行时 dashboard、MCP API 返回 HTTP 410。

## 停止与删除

`stopHermesRuntime` 只停止同工作区绑定的旧资源，保留数据卷。已有具名 Work 取消操作只能针对持久化的旧 run，并且要求运行时已在运行；绝不恢复或创建运行时。取消结果不明时不重放操作。

`cleanupHermesRuntime` 仅用于明确授权的删除，保留严格容器/卷清理和工作区操作准入。停止、应用重启或退役均不构成删除授权。启动恢复不会启动保留的 Hermes deployment，也不会运行旧 dashboard broker。

## 归档导入与转换

历史归档导入保留为离线存储操作：安全解包到停止、网络隔离的历史存储，保留文件和导入标识，不投影凭据，不启动 Agent。存储实现见 [`archive-storage.ts`](../src/lib/agents/hermes/archive-storage.ts)。

新工作应创建 Pi Agent，复制可转换配置，明确重新授予能力，并发布完整修订；不能声称恢复旧原生状态。旧消息和卷仍是只读记录。Toolkit 的可转换能力冻结为私有包，不自动重新发布公开版本。

旧客户端凭据不能用于新执行；必须使用新登记范围和固定会话 MCP broker。所有权和恢复遵循[运行时运维](./RUNTIME_OPERATIONS.zh-CN.md)；本文不授权生产部署或删除数据。
