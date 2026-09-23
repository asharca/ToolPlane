# 原生 A2A 任务服务

> [English](A2A_NATIVE.md)

现在也可以在 **Agent 设置 → A2A 接入** 中开启服务、创建凭据和复制示例，见[控制台指南](A2A_CONSOLE.zh-CN.md)。

本功能使用 A2A **1.0** 网络协议，依赖精确锁定的官方 `@a2a-js/sdk@1.2.0`。
协议版本与 SDK 版本不同。依据 [A2A 规范](https://a2a-protocol.org/latest/specification/)
实现 JSON-RPC 绑定；没有启用 SDK 的 v0.3 兼容层。

## 新架构，而不是 Responses 接口改名

```text
外部 A2A 客户端
  → A2A 身份与显式发布授权
  → 官方 JSON-RPC 解码 / 编码
  → NativeA2AHandler
  → A2AContext / A2ATask / A2ARequest / A2AEvent
  → 独立持久任务 Worker
  → TaskExecutor 运行时端口
  → 隔离的发布版本执行环境
```

任务核心不调用 `prepareAgentResponse`、`executePreparedAgentResponse`、旧内部协作
Worker 或私人 Conversation。Task 是业务生命周期，不是某一次 HTTP 或模型调用。
Context 可以包含多个 Task；它绑定调用身份、发布版本和独立运行会话，不允许跨客户端借用。
旧 Responses 接口保留兼容；两条链路只共享发布、身份验证、运行环境与并发准入基础设施。
当前正式接上的公开执行适配器是隔离 Hermes；其他运行时不得未经隔离验收自动发布。

## 显式开启

先在控制台发布一个有效的公共 Agent Endpoint。默认 `a2aEnabled=false`，不会自动公开
工作区 Agent。使用工作区所有者或管理员的**账户级 Bearer Token**调用管理入口：

```bash
curl "$TOOLPLANE_URL/api/v1/workspaces/$WORKSPACE/agents/$AGENT_ID/a2a" \
  -H "Authorization: Bearer $ACCOUNT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"clientName":"External A2A integration"}'
```

响应中的 `token` 只返回一次，保存到服务端秘密存储；不要放在提示词、日志、前端或仓库。
指定 `clientName` 会创建新的客户端，**此管理操作不是幂等的**。响应丢失时先检查公共服务
客户端列表，不能盲目重复创建。只切换开关时省略 `clientName`。关闭使用 `{"enabled":false}`。
服务凭据、Toolkit Token、运行 Token、Cookie 均不能用来批准自己的发布。

新客户端只有 `a2a:send`、`a2a:read`、`a2a:cancel`，取消同时要求读取权限。
旧的 `responses:*` 权限不自动获得 A2A 权限。账户级或运行时 Token 不能调用公共任务接口。
整个链路是服务端到服务端接入；浏览器 Origin 被拒绝。本版没有 OAuth 自动发现/授权交换。

## Agent Card 与协议入口

管理响应返回实际路径。每个 Endpoint 的地址为：

```text
GET  /api/v1/agent-endpoints/{endpointId}/a2a/.well-known/agent-card.json
POST /api/v1/agent-endpoints/{endpointId}/a2a
```

Card 也需要该 Endpoint 的授权凭据，可通过直接配置的 Card URL 发现，不把根域名的
well-known 文档改成自定义 Agent 数组。Card 地址来自部署者配置的 `NEXT_PUBLIC_APP_URL`，
不能由不可信 Host Header 决定；非 loopback 部署要求 HTTPS。
Card 只含公开名称、服务修订、能力、地址和鉴权声明，不含提示词、Provider、内部工具或凭据。

```bash
curl "$TOOLPLANE_URL/api/v1/agent-endpoints/$ENDPOINT_ID/a2a" \
  -H "Authorization: Bearer $A2A_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'A2A-Version: 1.0' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{
    "message":{"messageId":"review-001","role":"ROLE_USER","parts":[{"text":"审查这份补丁。"}]},
    "configuration":{"returnImmediately":true,"historyLength":0}
  }}'
```

返回标准 `result.task`，状态是 `TASK_STATE_SUBMITTED` 等官方枚举，不是旧 Response ID。
默认 `returnImmediately=false` 等待任务终结或要求输入/授权；连接断开不会取消已接受任务。

| 标准方法 | 实现 |
| --- | --- |
| `SendMessage` | 原子接受、可立即返回、相同 messageId 同内容去重 |
| `SendStreamingMessage` | Task 快照、状态更新、最终 Artifact 更新 |
| `GetTask` | 当前身份范围内查询；historyLength=0 不返回历史 |
| `ListTasks` | 状态时间倒序、带签名且绑定查询/身份的游标分页 |
| `CancelTask` | 请求停止，执行器结束后才确认取消；已完成等终态不可取消 |
| `SubscribeToTask` | 首事件为当前 Task；终态任务返回 UnsupportedOperationError |

`ListTasks.nextPageToken` 总是存在；末页是空字符串。默认不包含 artifacts，开启
`includeArtifacts` 后才返回。游标不是数据库 offset，不可以挪到其他身份或过滤条件使用。
重订阅发送当前快照和后续持久事件，不承诺任意 Last-Event-ID 历史重放。
原生任务流目前不包含模型逐 token 增量；不会冒充 Token 流。

## 生命周期和安全边界

同一 Context 仅允许一个活动 Task。后续新的任务使用相同 Context；补充信息必须使用
原 Task 的 taskId、新 messageId，且原任务处于 INPUT_REQUIRED。COMPLETED、FAILED、
CANCELED、REJECTED 不重开。AUTH_REQUIRED 不接受模型消息作为授权；当前 Hermes 适配器
不会把普通文本猜测成原生审批或追问事件。

任务、接收消息去重记录和初始事件在同一事务内写入。状态和交付物事件同样原子写入。
Worker 与 HTTP 请求解耦，执行租约防止过期执行器覆盖结果。取消请求不是停止确认，
已发生的工具副作用也不会回滚。重启时先完成平台运行时所有权恢复，再将不确定的
WORKING 任务失败终结；绝不自动重放可能有副作用的执行。

身份从已验证凭据取得，不接受 message.metadata 中的 workspace、client、subject 或
agentId 作为授权。读、继续、取消和订阅都限制到 Endpoint、客户端及授权主体。
密钥撤销、作用域变化、工作区关闭、Endpoint 禁用在运行和订阅期间继续检查。
任务内容不进入公共诊断日志，未知异常只返回通用错误。

当前限制：请求体 256 KiB；输入 20,000 字符；输出 65,536 字符；Task 快照 512 KiB；
每任务最多 32 条历史消息；每 Context 最多 128 个任务；每客户端最多 100 个 Context、
1,000 个保留任务；Worker 最多四个执行；每身份八个、全局 64 个观察连接。
任务最长 840 秒，实际取 Endpoint 超时、凭据寿命和 Context 到期时间中的最小值；补充
信息不会延长原截止时间。Context 最多保留 30 天，终结后按有限批次清理。
这些不等于精确的金额或 Token 预算；聚合输出/存储额度仍需独立验收。

## 支持范围与验证

只声明 JSONRPC、streaming 和 text/plain。REST、gRPC、Push Notification、扩展 Card、
文件与结构化输入均未声明实现；不支持的能力返回标准错误，不伪造成功。
没有自动注册任意外部 URL，不会抓取调用方提供的文件 URL。
内部 Agent 现在可以通过独立的[原生协作入口](A2A_LOCAL_COLLABORATION.zh-CN.md)使用同一任务核心，支持父任务等待与续轮。旧聊天/Work/委派入口尚未自动迁移，运行时原生审批桥接仍未实现。

升级前按平台单所有者流程应用 `20260922000000_a2a_native_tasks` 并重新生成 Prisma Client。
此迁移新增独立表、索引和显式开关，不迁移/重放旧会话或旧协作任务。

```bash
pnpm exec prisma generate
pnpm vitest run tests/unit/a2a-*.test.ts tests/integration/a2a-native.test.ts
pnpm exec tsc --noEmit
pnpm lint
```

单元测试使用未改动的官方 ClientFactory/JSON-RPC transport 进行互通验证。
集成测试使用隔离数据库和替身执行器；`TOOLPLANE_TEST_PGLITE=1` 仅用于本地嵌入数据库，
明确跳过真实 PostgreSQL 并发锁验证。CI 不应设置该标记。不能把此模式结果当成真实
PostgreSQL 并发、真实 Hermes/CLI/模型端到端验收或官方 TCK 认证。
