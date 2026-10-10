# 日志与审计

> **English**: [OBSERVABILITY.md](./OBSERVABILITY.md)

管理后台 `/admin/logs` 读取独立的结构化事件。工作区「日志」只能读取自身日志：
部署 MCP 请求与响应正文按原权限展示，成员也可查看获准的脱敏 A2A 正文；
其他 Agent 与非部署 API 仍按原来的显式采集策略处理。

## 健康概览与快捷排障

`/admin/logs` 默认展示并导出全部日志来源；A2A 请求、HTTP、执行链、运行时和审计
可单独切换。A2A 页默认仅展示 `a2a.request`，按任务、上下文、根任务、父任务或事件名
显式检索时可查看关联的生命周期与出站日志。可折叠的全局健康概览固定观测全部工作区
最近 15 分钟，不受当前列表筛选影响。
各来源分别统计错误/超时（含 error 严重级别）和拒绝事件；嵌套调用也是事件，不能当作
独立请求数。无数据明确显示“暂无近期数据”；“未观测到错误”不保证服务可用，也不是
供应商主动探测。点击刷新重新获取快照，不自动订阅实时更新。

MCP 部署异常结合持久化状态与进程监管状态：failed/error，以及原为运行/部署中但
已无监管进程的部署需要关注；主动停止不算异常。写入失败/丢弃计数只覆盖当前 worker
自启动以来的情况。该页面依赖应用与数据库，不替代外部宕机监控。

排障顺序：点击日志来源卡片 → 快捷筛选失败/超时/拒绝 → 查看默认展开的错误聚合
及最近出现时间 → 进入事件详情与调用链。卡片跳转固定日志时间范围，顶部健康快照
仍独立更新。原有脱敏、管理员授权、详情访问审计及保留策略保持不变。


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
Agent 开启 15 分钟的诊断抓取。非 Agent 的 MCP 部署请求会默认保留已脱敏且限长的详情，
供工作区成员在部署“MCP 调用日志”页和请求日志总览排查。抓取的开始、停止和保留期变更都会记审计。即使抓取开
启，公共 Agent API 的载荷仍然被抑制。密码、凭据、Cookie、Authorization 头、已知
runtime/provider 密钥和常见 token 模式在写入数据库或 stderr 前脱敏。任意用户文本不保
证匿名；只在运维必要时开启载荷抓取，并相应限制管理员访问。

传输层记录实际 JSON-RPC 请求与上游响应信封，包含上游错误；网络失败没有收到响应时
不伪造响应正文。网关记录按工作区、部署和调用上下文关联实际传输详情，不重复展示
同一次调用。总览仍按网关请求统计、分页；独立的工具发现记录仍在部署日志中查看。
工作区 MCP 正文必须带有采集时写入的安全许可标记；历史未标记详情因无法确认原始采集策略，
对工作区读者仅展示元数据，管理员诊断读取不变。过期或不可用正文不提供复制按钮。

设置在每个 worker 内最多缓存 10 秒；每次写入时检查过期。显式停止最长需要这么久才能
传到其他 worker。Node 启动钩子每五分钟在 Postgres advisory lock 下尝试清理。清理每
张表最多十批、每批 1,000 行。detail 的保留不能超过其父事件。审计有自己的保留策略。

成功鉴权的 A2A 协议、通信工具和原生用户入口默认保留脱敏请求与响应，无需开启诊断
抓取。新增 A2A 与部署 MCP 正文最多保留 `min(detailDays, eventDays, 1)` 天；不延长已有
正文、不补采历史。工作区成员可以读取保留期内获准的脱敏 A2A 正文，读取前必须成功写入访问审计。
未鉴权或被拒请求不采集正文；空响应与未收到响应分别记录。

UI 使用 50 行的 keyset 分页和有界的、最长 31 天的检索窗口。Trace 视图上限 500 个事
件。JSONL 导出最多包含 1,000 条元数据或审计记录，不含载荷；响应声明
`x-export-limit: 1000`。

## 管理工作流

- `/admin` 保留待审核、异常部署、资源和近期失败。MCP 请求仅统计 `gateway.request`；
  入站 A2A 请求仅统计 `direction=inbound` 的 `a2a.request`。请求排障与最近请求不把
  嵌套 HTTP、任务生命周期或出站轮询计入请求数。无请求时不推断延迟或服务健康。
- `/admin/reviews` 把市场和 Agent 发布合并成 25 行的队列，最旧的待审在前。过滤器包
  括资源类型、审核状态和发布者/名称。`/admin/market` 仍是目录维护。审核详情显示不可
  变工件、变更的 manifest 段落、审核人身份和审核备注。
- 用户和工作区详情链接到对应范围的事件和审计。`actorId` 指操作者；`targetType` 和
  `targetId` 过滤受影响的审计资源。详情页的返回链接保留列表过滤器，且只接受本地管
  理 URL。
- A2A 当前调用通过服务器生成的 request/trace ID 串联，跨轮询或重启通过本地任务 ID
  与根任务 ID 检索；任务耗时从受理到实际提交状态，不是 HTTP 延迟。详情显示请求、响应、
  RPC 错误及已匹配的 HTTP 入口，正文读取前必须成功写入查看审计；过期、未采集或
  工作区不可见的正文不能复制。
- 工作区侧边栏「日志 → A2A 请求」位于 `/app/[workspace]/observability?tab=a2a`。
  通过 Agent ID 筛选该 Agent 的直接调用与公开 Endpoint 调用，
  请求数量和耗时统计使用同一筛选范围。成员可在详情页查看保留期内的脱敏正文，
  每次读取都会审计；按任务 ID 检索不会扩大工作区范围。列表、trace 与导出仍只含元数据。
  管理员保留独立的后台详情入口。界面统一称「日志」，现有 `/observability` URL 不变。
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

事件声明 `metadata-only`（默认）、`diagnostic`、`agent-content`、`request-response` 或 `forbidden`。仅显式成功鉴权的请求边界使用 `request-response`；15 分钟抓取控制额外内部诊断，并非 A2A 默认正文开关。普通诊断采集不会自动启用 Agent 内容；管理员必须为指定资源显式选择 `includeAgentContent`，仍受时间限制与访问审计约束。Agent 内容详情最多保留 24 小时，配置更短时从短；导出仍只包含元数据。

惰性详情读取器仅在策略和采集检查允许后执行。响应读取最多 32 KiB 或 200 ms，不采集 SSE。敏感 Agent 事件在元数据仅保留通用事件名/错误类别，不把任意 attributes 或错误文本写入 stderr，也不为判断成功而复制完整载荷。父上下文 `suppressPayload` 单向继承，子级不能关闭；`forbidden` 与公共 Endpoint 禁止策略优先于所有采集开关。

同时具备工作区和部署范围、且不属于 Agent 上下文的 `gateway.request` 与 `mcp.rpc` 事件，会默认保留脱敏后的载荷供部署“MCP 调用日志”页和工作区请求日志总览读取；Agent 上下文和公共 Endpoint 不适用此默认行为。

脱敏不等于任意业务文本的匿名化；即使显式开启，也须限制管理员访问并缩短保留时间。
