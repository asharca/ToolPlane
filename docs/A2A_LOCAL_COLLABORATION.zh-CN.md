# 原生 A2A 内部协作

> [English](A2A_LOCAL_COLLABORATION.md)

控制台现在提供显式开关、连接信息与本地任务调试，见[A2A 接入指南](A2A_CONSOLE.zh-CN.md)。下面的 Bearer API 保持不变；这不表示旧 Work／聊天入口已自动迁移。

本文供维护 Agent 配置、原生执行器和任务调度的开发者使用。内部任务与
[公开 A2A 服务](A2A_NATIVE.zh-CN.md)复用同一个 A2A 1.0 Handler、Task、Context、
消息去重、事件记录和 Worker。官方 `@a2a-js/sdk@1.2.0` 的网络类型与状态保持不变。

## 边界与入口

本地 Context 使用 `targetKind=local`、工作区、Agent、调用用户和配置指纹；不创建虚假的
Endpoint、API 客户端或私人 Conversation。公开 Context 保留发布修订与客户端隔离。
公共凭据不能访问本地入口，公共 Hermes 执行器也不会通过这次改动取得私人 Agent 的权限。

支持独占 Docker 沙箱的 Pi、Claude Code、DSH、Hermes RPC；每个目标使用自己的模型、
MCP、Skill、Toolkit 和已配置沙箱。`Context.id` 是独立的原生会话身份，**不是新文件系统**。
同一个 Agent 的不同任务仍可能看到该 Agent 沙箱中已有的文件和原生记忆，因此只应对
有权使用这些资源的工作区成员开启。托管 `hermes` 保持公开执行适配，不自动加入内部协作。

新链路直接接原生沙箱执行端口，不调用旧 `runAgentTurn`、旧协作 Worker、Responses API
或 `runDedicatedSandboxTurn`。受支持运行时的经典聊天、Work、Control MCP 和显式授权渠道
现在通过[统一入口与执行前审批](A2A_INGRESS_APPROVALS.zh-CN.md)使用同一核心；托管 Hermes
仍有兼容路径，历史数据不自动重放。[A2A 接入页面](A2A_CONSOLE.zh-CN.md)提供开关、连接示例和任务树。

## 显式启用和调用

先配置调用方与目标的模型、联网 Docker 沙箱及工具，在调用方已有的“子 Agent”设置
中选择允许的目标。这些有向关联只表示委派范围，不自动开放整个工作区。

调用方和每个目标都默认关闭内部 A2A。由工作区所有者或管理员分别启用：

```bash
curl -X PUT "$TOOLPLANE_URL/api/v1/workspaces/$WORKSPACE/agents/$AGENT_ID/a2a/local" \
  -H "Authorization: Bearer $ACCOUNT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}'
```

用同一入口的 `GET` 获取标准 Agent Card，`POST` 发送 A2A 1.0 JSON-RPC。
普通成员可以调用已明确开启的本地 Agent，但不能启用它。管理写入会在事务中重新检查
管理员身份并写审计。仅接受有效的账户级 Bearer；Cookie、Toolkit Token、公共服务密钥、
运行凭据和带 Origin 的浏览器请求不能作为该入口的身份。

```bash
curl "$TOOLPLANE_URL/api/v1/workspaces/$WORKSPACE/agents/$AGENT_ID/a2a/local" \
  -H "Authorization: Bearer $ACCOUNT_TOKEN" \
  -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{
    "message":{"messageId":"review-001","role":"ROLE_USER","parts":[{"text":"分别委派代码审查与测试，汇总结果。"}]},
    "configuration":{"returnImmediately":true,"historyLength":0}
  }}'
```

后续查询、订阅、取消及输入补充仍使用标准 `GetTask`、`SubscribeToTask`、`CancelTask`、
`SendMessage`。同一消息 ID 只可重试完全相同的内容。`taskId` 用于尚未终结且需要输入的
任务；已终结任务需要创建新任务。原生 RPC 和返回状态不增加自定义的委派方法或等待状态。

## 运行时协作工具

每轮本地任务会注入一个受限 MCP 桥接器。MCP 是 CLI 的工具接入口，不是另外一套 A2A
网络协议或独立的任务存储。

| 工具 | 作用 |
| --- | --- |
| `a2a_list_agents` | 仅返回当前被关联且已开启、配置有效的目标 ID 与名称 |
| `a2a_send_message` | `agentId` 加标准 A2A `SendMessageRequest`，交给同一任务核心，立即返回 Task |
| `a2a_get_task` | 查询当前任务直接委派的子任务，含追问与交付物 |
| `a2a_cancel_task` | 请求取消直接子任务及其后代 |
| `a2a_await_tasks` | 记录要等待的直接子任务 ID，然后正常结束本轮 |
| `a2a_request_input` | 记录追问，然后正常结束本轮；不能批准操作 |
| `a2a_publish_artifact` | 向当前任务发布不可变、有界的文本、JSON 或内联文件交付物 |

模型不能提供调用用户、父任务、根任务、委派深度、截止时间或授权凭据来覆盖服务端状态。
签名运行凭据同时绑定任务与本轮执行租约，不能拿普通模型代理 Token 委派任务。
进入等待、追问或终态后，该轮凭据立即失效；恢复时重新签发。模型与 MCP 代理也检查这一
租约，而不只是协作接口检查。账户 Token 不投影到沙箱中。

## 等待、追问和恢复

父 Agent 委派 B、C 后调用 `a2a_await_tasks`，并**正常结束当前执行轮次**。核心记录等待
条件、回收执行租约和沙箱写入槽；父 Task 对外仍为 `TASK_STATE_WORKING`。内部 `phase`
区分 queued、executing、waiting、resumable、paused、done，不把这些作为 A2A 枚举发送。

所有选中的子任务完成、失败、取消或需要输入/授权时，父任务进入可恢复阶段。领取动作
在事务与租约控制下只发生一次；父任务在原 Context 获得一条用户角色的结果通知并继续。
子任务内容是**不可信任务数据**，不是系统指令或权限。结果过大时只附 ID，调用方通过
查询工具取回，不把无限文本塞进上下文。

子任务追问会唤醒父任务。父任务可用相同子 `taskId`、新 `messageId` 补充信息，再次等待；
无法回答时可向自己的调用者追问。即使父任务忘记显式等待，正常退出时也会自动等待仍未
终结的直接子任务，避免把委派中的工作误报为全部完成。不能通过崩溃或超时把任务伪装
成一次成功暂停。

根任务取消、失败或授权失效会传播至后代。运行中的任务先收到取消请求，执行器真正
停止后才确认取消；已经发生的外部操作不会回滚。服务重启保留持久等待/可恢复记录，但
原先正在执行且结果不确定的任务失败终结，不自动重放其副作用。

## 交付物

本地 Agent Card 声明 text/plain、text/markdown、text/x-diff、application/json 和
application/octet-stream 输出；输入仍只接受 text/plain。公开 Hermes 执行配置仍为文本输出，
不会因本地支持新格式而自动扩大公开能力。

运行中的本地 Agent 可调用 `a2a_publish_artifact`：

```json
{
  "artifactId": "review-v1",
  "name": "review.json",
  "parts": [{ "data": { "approved": false, "findings": [] }, "mediaType": "application/json" }]
}
```

每个 Part 只能有标准 A2A 的 `text`、`data`、`raw` 之一。`raw` 必须是规范 Base64，且指定
受支持的 mediaType；`data` 是 JSON 对象。每个交付物最多八个 Part，解码后的文件或 UTF-8
内容合计不超过 32 KiB。拒绝文件系统路径、远程 URL 和旧版 `file` 结构；名称不是文件路径。

同一任务内 artifactId 不可覆盖：相同内容重试不新增事件，不同内容需使用新 ID。最多发布
十五个显式交付物，为最终结果预留一个位置；还受快照、事件记录与工作区限额约束。
发布不代表任务完成。只有尚在执行、授权有效、未取消或暂停的当轮租约才能发布。

会检查 `acceptedOutputModes`。要求 JSON 时，Agent 必须显式发布 JSON 交付物；不能把
最后一段普通文本猜成 JSON 并伪报格式满足。交付内容始终是任务数据，不是新权限。

## 调度与限制

任务根链最多 16 个任务、3 条委派边；父任务最多恢复 16 次。后代共享根截止时间，最长
840 秒，补充消息不能延长。每工作区最多 16 个活动本地任务，每个调用身份最多保留
256 个任务；Context 最多 128 个任务。输入、输出、快照和消息数量沿用原生核心限制。
工作区用户入口每分钟最多 120 次请求；受限运行时入口也有独立请求限制。

整个核心仍只有一个运行时所有者、最多四个执行槽，优先调度更深层任务。等待中的父任务
不占执行槽。原生沙箱写入互斥同时覆盖聊天、Work 与 A2A；沙箱繁忙时 A2A 保持排队，
不会启动后再重试可能带副作用的执行。同一配置沙箱的不同原生会话也不能同时改写配置。

这些不是金额或精确 Token 预算。聚合准入计数见[资源限额](A2A_RESOURCE_LIMITS.zh-CN.md)。
大文件/二进制输入、自动历史记忆迁移和分布式执行仍未支持。原生审批的运行时限制见[专门说明](A2A_INGRESS_APPROVALS.zh-CN.md)。

## 迁移与验证

应用 `20260922010000_a2a_local_collaboration` 并重新生成 Prisma Client；已有原生核心
迁移必须先应用。本迁移为已有公开 Context 回填工作区并保留发布修订、身份和任务快照，
增加本地目标约束与调度字段，不迁移、重放或删除旧聊天/协作数据。

```bash
pnpm exec prisma generate
pnpm vitest run tests/unit/a2a-*.test.ts tests/integration/a2a-local.test.ts tests/integration/a2a-native.test.ts
pnpm exec tsc --noEmit
```

运行时适配测试覆盖四种 dedicated runtime 的投影；任务循环测试使用替身执行器，MCP
互通使用官方未修改客户端。PGlite 模式跳过真实 PostgreSQL 并发测试，不能作为并发锁
正确性证据。尚未完成四种真实 CLI/模型、浏览器端到端验收或官方 A2A TCK 认证。

本版还需应用 `20260923050000_a2a_storage_accounting`，参见[资源限额与迁移](A2A_RESOURCE_LIMITS.zh-CN.md)。

内部任务现在可通过[远程 Agent 注册与委派](A2A_REMOTE_AGENTS.zh-CN.md)调用经过单独批准的外部 A2A 服务。部署来源白名单、工作区注册和发起方 Agent 授权都必须显式配置；不自动开放私人资源。
