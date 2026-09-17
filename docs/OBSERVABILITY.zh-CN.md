# 日志与审计

> **English**: [OBSERVABILITY.md](./OBSERVABILITY.md)

管理后台的 `/admin/logs` 读取结构化事件，与工作区业务记录相互独立。工作区可观测性仍
仅限于登录用户自己的工作区，且绝不包含诊断载荷。

## 存储

- `LogEvent`：可检索的元数据——时间戳、严重级别、域、结果（outcome）、实际 HTTP 状态、
  RPC 方法/工具名、耗时、错误类型/代码、资源 ID、请求 ID 以及 trace/span/parent span ID。
- `LogDetail`：可选的脱敏错误链/堆栈和限定范围的诊断载荷，上限 32 KiB 合法 JSON。过期
  的 detail 在读取时排除。
- `AuditEvent`：操作者、动作、目标、前后变更和关联 ID。应用层变更追加这些记录；实体删
  除不会级联删除诊断或审计历史。

`httpStatus` 是传输层结果；`outcome` 是业务结果。HTTP 200 但 JSON-RPC 返回 `error` 或
`result.isError` 的 MCP 响应算错误。工作区 MCP 指标统计 `gateway.request`，不统计其嵌
套的传输或 HTTP 事件。计数、平均值、P95 和按小时桶都在 Postgres 中聚合。

## 埋点

`withRequestLogging` 在鉴权之前包裹 JSON/网关处理器，分配服务器生成的请求 ID 并记录
早期失败。SSE 的完成、失败和取消各记录一次，不缓冲响应流。它不记录原始 URL、请求头
或请求体。

`withLogContext` 用 AsyncLocalStorage 串联子 span。已验证的资源查找会丰富上下文；调用
方提供的请求 ID 不被信任。带签名的沙箱 runtime grant 把 trace 血缘带到模型和 MCP 回调。
Work 执行启动独立（detached）上下文，后台任务不会继承其他请求的操作者。Native 运行记
录模型用量、首个输出延迟、停止原因和工具结果。Hermes/沙箱埋点记录可用的 runtime 事件，
不记录私有推理过程，也不记录 runtime 的每一次内部操作。

`recordEvent` 同时向 stderr 输出脱敏后的 JSON。数据库写入限制为每个 worker 最多 32 个
在途写入，带较短的获取/事务期限。存储失败和过载不会拒绝业务请求。管理页显示该 worker
的失败/丢弃计数器。这是 best-effort 诊断，不是持久的外部队列：进程骤停或持续过载可能
丢事件。需要更强运维持久性时，外部日志收集器可以摄取 stderr。stderr 背压同样有界。

关键数据库变更在同一个事务客户端上使用 `writeAudit`：用户角色与状态、管理设置、
provider 凭据、账户 API token 和 Agent API key、分类编辑、目录元数据/配方、市场审核与
发布控制，以及单条 registry skill 写入。目录审计条目不含 manifest、skill 正文和配方凭
据值。审计失败会回滚该变更。涉及外部进程的删除会先记录意图再拆除，最后记录成功/失
败。查看诊断详情和导出日志本身也需要成功的访问审计。这是应用层的只追加存储，不是能
对抗数据库管理员的防篡改存储。

## 抓取与保留

默认保留期：事件 30 天、detail 7 天、审计 180 天。管理员可以为现有的工作区、部署或
Agent 开启 15 分钟的诊断抓取。抓取的开始、停止和保留期变更都会记审计。即使抓取开
启，公共 Agent API 的载荷仍然被抑制。密码、凭据、Cookie、Authorization 头、已知
runtime/provider 密钥和常见 token 模式在写入数据库或 stderr 前脱敏。任意用户文本不保
证匿名；只在运维必要时开启载荷抓取，并相应限制管理员访问。

设置在每个 worker 内最多缓存 10 秒；每次写入时检查过期。显式停止最长需要这么久才能
传到其他 worker。Node 启动钩子每五分钟在 Postgres advisory lock 下尝试清理。清理每
张表最多十批、每批 1,000 行。detail 的保留不能超过其父事件。审计有自己的保留策略。

UI 使用 50 行的 keyset 分页和有界的、最长 31 天的检索窗口。Trace 视图上限 500 个事
件。JSONL 导出最多包含 1,000 条元数据或审计记录，不含载荷；响应声明
`x-export-limit: 1000`。

## 管理工作流

- `/admin` 优先展示待审核、异常的有效部署状态和近期失败。请求指标明确统计 MCP
  `gateway.request` 事件。
- `/admin/reviews` 把市场和 Agent 发布合并成 25 行的队列，最旧的待审在前。过滤器包
  括资源类型、审核状态和发布者/名称。`/admin/market` 仍是目录维护。审核详情显示不可
  变工件、变更的 manifest 段落、审核人身份和审核备注。
- 用户和工作区详情链接到对应范围的事件和审计。`actorId` 指操作者；`targetType` 和
  `targetId` 过滤受影响的审计资源。详情页的返回链接保留列表过滤器，且只接受本地管
  理 URL。
- 设置页显示保留期内最近一次成功的审计记录，并在离开未保存编辑前警告。没有审计历
  史意味着没有记录到修改者，不一定是设置从未变过。保存失败保留输入；保存一个分区不
  会丢弃另一个分区的未保存修改。
- Registry 同步报告单个失败路径。重试使用上次结果的来源，且只重试仍存在于该
  registry 中的路径。失败列表是页面状态，刷新即清空。`pnpm skills:sync:tp` 使用 Node
  的 `react-server` condition 来运行共享的 server-only 审计写入器。

## 破坏性升级

迁移 `20260907000000_unified_observability` 删除 `RequestLog` 并创建三张新表。没有回
填，也没有双写。其他业务表不变。如需要旧日志，请在升级前单独导出。

停止旧应用 worker，用 `pnpm exec prisma migrate deploy` 应用迁移，运行
`pnpm db:generate`，然后用新代码构建并重启所有 worker。不要让新旧 worker 同时连接已
迁移的数据库。开发 HMR 保留的 Prisma client 也需要完整重启服务器。

针对性检查：

```bash
pnpm vitest run tests/unit/logging.test.ts tests/unit/logging-storage.test.ts tests/unit/agent-runtime-access.test.ts tests/integration/logging.test.ts tests/integration/observability.test.ts
pnpm exec tsc --noEmit
pnpm lint
```

## 显式载荷策略

事件声明 `metadata-only`（默认）、`diagnostic`、`agent-content` 或 `forbidden`。普通诊断采集不会自动启用 Agent 内容；管理员必须为指定资源显式选择 `includeAgentContent`，仍受时间限制与访问审计约束。Agent 内容详情最多保留 24 小时，配置更短时从短；导出仍只包含元数据。

惰性详情读取器仅在策略和采集检查允许后执行。响应读取最多 32 KiB 或 200 ms，不采集 SSE。敏感 Agent 事件在元数据仅保留通用事件名/错误类别，不把任意 attributes 或错误文本写入 stderr，也不为判断成功而复制完整载荷。父上下文 `suppressPayload` 单向继承，子级不能关闭；`forbidden` 与公共 Endpoint 禁止策略优先于所有采集开关。

脱敏不等于任意业务文本的匿名化；即使显式开启，也须限制管理员访问并缩短保留时间。
