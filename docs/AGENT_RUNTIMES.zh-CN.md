# Agent 运行时实现：原生 Pi SDK

> **English**: [AGENT_RUNTIMES.md](./AGENT_RUNTIMES.md)

本文说明 ToolPlane 唯一的可执行 Agent 架构：在专属 Docker 沙箱中使用官方 `AgentSession` 的 **Pi SDK 0.87.1**。这不是用户电脑上的 Toolkit 安装指南；后者见 [Toolkit 同步](./TOOLKIT_SYNC.md)。所有权、恢复和受控切换流程见[运行时运维](./RUNTIME_OPERATIONS.zh-CN.md)。

可执行路径只有一条。普通 Pi CLI、Claude Code、DSH、Hermes 和旧 Harness 都不是可选执行器或恢复降级方案。非 Pi 历史消息和绑定文件只读；只保留真正已绑定操作的取消/排空。转换创建需要显式授权的全新 Pi 草稿，不恢复旧会话。

## 1. 配置不等于执行授权

**Agent** 管理工作区内的配置与资源关系；可编辑**草稿**与不可变的已应用**修订**分离。**Conversation**、Work 准入或本地 A2A context 固定修订；对应的**会话沙箱**提供独立持久文件系统和原生进程状态。

产品创建 Pi Agent，内部可执行 runtime kind 是 `pi-sdk`，没有第二个 SDK 选择器或可选 CLI 模式。创建 Agent 或沙箱记录不代表运行时就绪，也不构成执行授权。

### 保存草稿 → Prepare → 审阅 → Apply

1. **保存草稿**只修改可编辑配置，不改变已发布默认修订或任何现有会话。
2. **Prepare** 在发布事务外完成依赖捕获/构建与原生能力预检。准备结果冻结 digest 镜像、Pi 版本、网络/资源限制、可选的校验和验证初始快照、凭据引用、模型与指令、Skill/包制品及 MCP/A2A 授权；凭据明文不进入配置。
3. **审阅**准确的准备结果与能力/权限变化。**Apply** 同时提交预期当前修订 ID，重新验证实时权限、制品、源摘要与原生预检，再原子比较并切换默认修订（CAS）。预期版本过期或校验失败时保留旧默认，须重新 Prepare 和审阅。
4. **回滚**以同一 Agent 保留的历史修订发布一个新版本，仍须预期当前修订检查和实时验证。不改写历史、不恢复撤销授权，也不移动现有会话固定引用。

实现见 [`revisions.ts`](../src/lib/agents/revisions.ts) 和 [`revision-types.ts`](../src/lib/agents/revision-types.ts)。工作区安装包不等于为 Agent 启用。单项 Enable 和引导安装只将明确审阅的改动合入已应用修订，不发布无关草稿。卸载通过 CAS 发布仅移除该包的新默认，同时保留会话引用制品和共享 MCP deployment。

## 2. 固定执行链路

```text
Chat / 消息渠道 / Work / 本地 A2A
  → 鉴权，校验工作区、Agent 与会话准入
  → 固定不可变修订 ∩ 当前实时权限
  → 获取会话/沙箱租约并执行并发限制
  → 获取该会话独立持久沙箱
  → sandbox-turn.ts / sandbox-runtime.ts
  → native-runtime-session.mjs 守护进程
  → pi-sdk-session.mjs：官方 Pi SDK 0.87.1 AgentSession
  → 受控模型 / 审批 / MCP / 协作 broker
  → 原生事件与完成回执
  → 调用方负责 UI 流、Work 状态与平台消息持久化
```

SDK 要求 Linux、Node 24，原生包架构须匹配 Docker daemon。可信运行时安装与冻结扩展制品落盘是不同操作；每轮不重新下载或安装审核过的扩展依赖。不得通过在活跃沙箱安装新版上游 Pi 或修改版本文件来升级。

沙箱不可用、固定引用无效、broker 拒绝或原生加载失败均停止执行，不选择宿主模型循环、普通 CLI、其他运行时、当前可变默认值，也不重放历史消息。

## 3. 源码导航

| 职责 | 源码 |
|---|---|
| 运行时能力分类 | [`runtime-kind.ts`](../src/lib/agents/runtime-kind.ts) |
| 不可变准备、发布与实时权限交集 | [`revisions.ts`](../src/lib/agents/revisions.ts) |
| 会话沙箱分配与保留绑定 | [`conversation-sandbox.ts`](../src/lib/agents/conversation-sandbox.ts) |
| 专属 turn 与 Docker 执行 | [`sandbox-turn.ts`](../src/lib/agents/sandbox-turn.ts)、[`sandbox-runtime.ts`](../src/lib/agents/sandbox-runtime.ts) |
| 持久守护进程与 SDK 宿主 | [`native-runtime-session.mjs`](../scripts/native-runtime-session.mjs)、[`pi-sdk-session.mjs`](../scripts/pi-sdk-session.mjs) |
| 原生能力预检与命名空间 | [`pi-sdk-preflight.mjs`](../scripts/pi-sdk-preflight.mjs)、[`pi-sdk-capabilities.mjs`](../scripts/pi-sdk-capabilities.mjs) |
| 快照字节与链接验证 | [`pi-sdk-package-files.mjs`](../scripts/pi-sdk-package-files.mjs) |
| 准确包会话固定引用 | [`pi-session-packages.ts`](../src/lib/agents/pi-session-packages.ts) |
| 运行时授权 | [`runtime-access.ts`](../src/lib/agents/runtime-access.ts)、[`runtime-grant.ts`](../src/lib/agents/runtime-grant.ts) |
| 原生工具审批钩子 | [`native-tool-approval.ts`](../src/lib/agents/native-tool-approval.ts) |
| 命令与会话操作 | [`runtime-commands.ts`](../src/lib/agents/runtime-commands.ts)、[`runtime-command-service.ts`](../src/lib/agents/runtime-command-service.ts)、[`conversation-operations.ts`](../src/lib/agents/conversation-operations.ts) |
| 消息、Work 与 A2A 调用方 | [`message-service.ts`](../src/lib/agents/message-service.ts)、[`work/coordinator.ts`](../src/lib/work/coordinator.ts)、[`local-executor.ts`](../src/lib/a2a/local-executor.ts) |
| UI 投影 | [`ui-stream.ts`](../src/lib/agents/ui-stream.ts) |

保留的历史事件 parser 用于解释已存数据，不意味着旧适配器仍可执行。

## 4. 会话固定引用与独立工作卷

新 Conversation、Work 和本地 A2A context 持久化 `agentRevisionId`；Work 在分配卷前的准入阶段固定修订。每个会话按固定环境懒创建持久沙箱，不读取 Agent 当前可变模板。并发会话不共享可写沙箱，会话文件不自动合并回模板。同会话内 turn 串行，Agent/平台并发限制及原生/session-MCP 租约继续生效。

`PiSessionPackageSet` 记录准确包 release/checksum 和 MCP 绑定。工作区包更新、新应用默认和回滚只影响新会话。普通卸载或下架保留已引用的批准制品；危险 release 撤销和当前 provider、凭据、包、MCP、方向性协作限制仍阻止执行。固定引用不是不可撤销权限快照。

数据库管理身份、修订/沙箱绑定、授权与任务回执；官方 SDK JSONL 文件管理原生对话状态。状态限定在 `/workspace/.toolplane/runtimes/pi-sdk/agents/<agent-id>/`；本地 A2A 复用持久化 context ID。私有宿主状态跟踪 new/fork/switch 后实际选中的 SDK 会话，与旧 Harness 检查点无关。

保留 context 必须重新打开原生会话。持久历史丢失，或宿主在首次会话文件落盘前丢失，返回 `PI_SDK_SESSION_MISSING`。历史修订/包固定引用未解决返回 `AGENT_REVISION_UNRESOLVED`；包集合不匹配返回 `PI_SDK_PACKAGE_SET_CHANGED`。应排查或恢复匹配工作卷，不得从当前默认猜测固定引用、修改 checksum、重放消息，或新建空会话冒充恢复。

## 5. 原生守护进程与请求 context

[`native-runtime-session.mjs`](../scripts/native-runtime-session.mjs) 只接受 `pi-sdk`，按私有状态路径哈希生成沙箱内 Unix socket，同一时间只允许一个请求，其他请求返回 `PI_SDK_BUSY`。它跨 turn 保留 SDK 子进程，处理停机、socket 断开和配置签名变化。守护进程重启不等于允许重放中断任务。

[`pi-sdk-session.mjs`](../scripts/pi-sdk-session.mjs) 加载固定 SDK，使用明确资源构建官方会话服务，关闭默认扩展、Skill、prompt、theme 和 context file 的自动发现。模型凭据仅在请求期间保存在内存；每次请求刷新 runtime token 和 MCP context，在初始化会话/模型执行前检查审批 readiness，结束后清理请求凭据。缺少 context 返回 `PI_SDK_CONTEXT_REQUIRED`；原生工具定义或审批模式变化返回 `PI_SDK_TOOLSET_CHANGED`，不静默改变保留会话。

结构化事件走专用文件描述符。扩展 stdout/stderr 不是可信协议通道，不能伪造 broker 结果。数据库消息持久化和 UI/Work 生命周期由调用方负责，不由低层执行器代办。

## 6. 受控 broker 与隔离边界

模型请求走 ToolPlane 的凭据化模型代理 `/api/v1/agent-runtime/model/{providerId}`，不把真实上游密钥交给扩展配置。运行时 grant 是范围受限的凭据，不是个人 API Token 或桌面安装 Token。代理重新校验当前资源关系，上游凭据由平台管理。不要将 runtime token、provider key 或数据库凭据暴露到提示词、日志或 issue 附件。

审批 readiness 对普通会话只允许 `/api/v1/agent-runtime/sessions/approvals`，对委派任务只允许 `/api/v1/agent-runtime/a2a/<task-id>/approvals`。辅助代码要求运行时鉴权、HTTP(S)、无内嵌凭据/query/fragment、不重定向以及有界响应。readiness 拒绝会阻止执行；不能用活动日志推断审批替代原生执行前钩子，也不能在 broker 失败后绕过审批。

MCP 工具必须同时位于不可变修订授权和当前显式工具 allowlist 内。会话 broker 校验固定镜像/recipe 和实时授权后懒启动隔离 sidecar；共享 deployment 停止不意味着可以丢弃有效固定 recipe，也不能借用共享进程。协作同样取固定/实时入站出站权限交集，并执行明确有界目标授权、工作区/操作者范围及循环/深度限制。

**工具审批不等于任意代码隔离。**已批准扩展可在沙箱内直接使用 Node、文件与网络。内置工具禁用项和 broker scope 不替代容器、挂载、网络边界。附件元数据也不能证明字节已挂载；可读路径提示必须来自有效沙箱 `runtimePath`。

回调连通性先检查 `TOOLPLANE_RUNTIME_ORIGIN` 和容器到平台实际网络。`sandboxRuntimeOrigin()` 将 loopback 转换为 `host.docker.internal`，取 URL origin，不保留配置中的子路径。

## 7. 原生预检、包与命令

Prepare/发布在固定隔离捕获镜像 `toolplane-pi-package-capture:0.87.1` 中使用真实 SDK loader，不靠扩展工厂源码文本猜测能力。原生命名空间检查覆盖工具、命令、Skill、prompt 及保留的生成 MCP 名称。冲突保留类型化 `PI_CAPABILITY_CONFLICT`；所选扩展加载失败保留 `PI_EXTENSION_LOAD_FAILED` 和有界阶段诊断。不静默丢弃冲突扩展或替换版本。

冻结快照包含依赖，执行和 reload 前完整验证字节与链接；篡改在 turn 执行前返回 `PI_PACKAGE_CHECKSUM_MISMATCH`。原生快照必须匹配执行平台/架构。启动不安装市场包、不执行包管理器 hooks，也不将发现任意用户配置作为降级方案。

命令保留原生调用大小写和 `:1` 等冲突后缀。未知命令报错，不转成模型提示词。纯命令完成回执不伪造成模型回答；终端扩展 UI 不渲染成 Web UI。

在自己拥有且空闲的会话发送 `/compact` 或 `/compact <自定义指令>`，对同一保留会话调用原生 `session.compact()`，须等待持久化的原生结果。绑定忙碌时拒绝第二个 writer；失败不回退宿主摘要或 CLI 压缩。渠道命令要求稳定 transport 消息 ID 去重；已鉴权会话命令生成原生回执 ID。Work 命令仍由 coordinator 管理。

## 8. 取消、排空与历史策略

取消停止绑定原生进程和会话 MCP sidecar，不删除持久工作卷。Docker 操作接入运行时所有权与取消跟踪。终止是有界清理，不是任意工具副作用的回滚。未知副作用和远端 ACK 保持未知，不能重放任务制造完成结果，也不承诺远端 exactly-once。会话/沙箱忙碌时，未领取的委派工作保持排队，直到正常租约重新可用。

单一 runtime owner 完成恢复后才接受执行。所有权丢失停止新工作；停机停止 coordinator/broker，排空或中止跟踪操作，最后释放所有权。不确定清理保留 dirty marker。HTTP liveness 不等于 readiness，换数据库/domain 或删除恢复标记不是接管流程。遵循[运行时运维](./RUNTIME_OPERATIONS.zh-CN.md)，包括准确且仅用于一次重启的恢复 ACK 要求。

**非 Pi 和未解决固定引用的历史会话只读。**保留历史消息、response、绑定文件读取、历史解析/归档访问及真正已绑定操作的取消/排空。不得启动、恢复、重放旧运行时，也不向其上传或开启执行终端。退役 Hermes 执行/model/profile/runtime MCP/dashboard/terminal/upload 端点返回 HTTP **410**，不是通向 Pi 的兼容路由。旧 `pi-harness` 任务标签只识别绑定清理。受控转换须排空旧任务，创建全新 Pi 草稿并重新审阅授权，不恢复旧运行时状态、不自动重新发布公开包。

排障优先使用关联 ID、状态、耗时与失败类型。Agent 内容采集须显式限时授权，见[可观测性](./OBSERVABILITY.zh-CN.md)。不要将完整原生输出、提示词或私有配置贴到公开 issue。

## 9. 回归源码与证据边界

保留的 [`native-runtime-session.test.ts`](../tests/integration/native-runtime-session.test.ts) 是无条件运行的原生 SDK daemon 回归，不是环境变量开启的真实 CLI/容器矩阵，不能证明真实 provider 或 Docker 验收。

[`pi-sdk-host.test.ts`](../tests/integration/pi-sdk-host.test.ts) 使用仓库已安装的 `@earendil-works/pi-coding-agent` 依赖，配合临时目录和受控本地 HTTP 模型/MCP/审批 fixture 启动真实 SDK 宿主。需要固定依赖、兼容 Node、子进程及本地 socket/文件访问；它不是付费 provider 测试，也不要求预装 CLI 的沙箱。[`pi-sdk-capabilities.test.ts`](../tests/integration/pi-sdk-capabilities.test.ts) 在 Vitest 模块转换之外调用已安装的原生 extension/Skill loader 和命名空间检查。

涉及数据库/Docker 的租约与通信套件只在已批准隔离环境、固定捕获镜像下串行运行；前提以[运行时运维](./RUNTIME_OPERATIONS.zh-CN.md#原生-sdk-验证)和各测试源码为准。不要使用生产 Agent 沙箱、并发操作同一测试数据库，也不要将 parser/unit/受控宿主结果当作真实 provider 验收。原生压缩须单独验证，通信 smoke 不覆盖它。

SDK 变更须同步维护修订 Prepare/CAS、原生预检、冻结制品、实时 broker 权限、会话固定引用、独立工作卷、命令与取消边界。两种语言文档随实现更新，不得为满足旧调用方或测试而恢复已退役执行别名。
