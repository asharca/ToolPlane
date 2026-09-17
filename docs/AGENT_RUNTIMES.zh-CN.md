# Agent 运行时实现：Pi、Claude Code 与 DSH

> **English**: [AGENT_RUNTIMES.md](./AGENT_RUNTIMES.md)

本文面向维护 ToolPlane、接入新运行时或排查 Agent 执行问题的开发者，说明 Pi、Claude Code（CC）和 DeepSeek Harness（DSH）的实际调用链、配置、原生会话和安全边界。这里讲的是 **ToolPlane 在沙箱中运行 Agent**，不是把 Toolkit 安装到用户电脑上的客户端；后者见 [Toolkit 同步](./TOOLKIT_SYNC.md)。

核对基线：`35c308e83e75228f1b42e7660ceefdc1e459d04f`（2026-09-17）。包版本和能力允许值以链接的源码为准，不以文档中的产品名称推断上游 CLI 的所有功能都已接入。系统全貌见[架构](./ARCHITECTURE.md)，Hermes 的独立实现见 [Hermes 运行时](./HERMES_AGENT_RUNTIME.md)。

独立的 Hermes RPC 沙箱适配器见 [Hermes RPC](./HERMES_RPC_RUNTIME.zh-CN.md)；本文仍聚焦 Pi、Claude Code 和 DSH。

## 1. 先分清四个概念

**Agent** 是工作区内的配置与资源关系；**runtime kind** 决定执行适配器；**Sandbox** 提供进程、文件系统和网络；**Conversation** 保存平台消息，并可作为原生会话的定位键。原生会话是否复用，还取决于调用方有没有传入 `runtimeSessionId`，不是只看数据库里有没有 Conversation。

[`runtime-kind.ts`](../src/lib/agents/runtime-kind.ts) 是公开种类、能力和内置工具分组的入口：

| 能力 | Pi | Claude Code | DSH |
|---|---|---|---|
| 持久化的 runtime kind | `pi` | `claude-code` | `dsh` |
| 模型绑定 | 单个 `providerId + model` | 单个 `providerId + model` | 单个 `providerId + model` |
| 执行环境 | 恰好一个可联网的 Docker 沙箱 | 同左 | 同左 |
| 控制台 / Work 执行 | 支持 | 支持 | 支持 |
| Control MCP 的 `create_agent` | 支持 | 未开放 | 未开放 |
| Hermes 专用附件上传能力 | 不支持 | 不支持 | 不支持 |
| 发布为公共 Agent Endpoint | 未开放 | 未开放 | 未开放 |

三者接受的 provider format 为 `openai`、`openai-responses`、`anthropic`，但走的适配路径不同，见第 4 节。附件能力为 false 不等于 Agent 不能读取沙箱文件；已有文件引用与 Hermes 专用上传接口不是同一个能力。

`native.ts` 是平台内部模型循环辅助模块，不是可提交给创建接口的 `native` 运行时。不要把 Pi CLI、平台使用的 `pi-ai` 库和前端 AI SDK UI message stream 当作同一层，也不要用根 `package.json` 的 `pi-ai` 版本推断沙箱内 Pi CLI 的版本。

## 2. 共用执行链路

```text
控制台消息 / 消息渠道 / Work / 子 Agent 调用
  → 入口鉴权、工作区与会话归属校验
  → resolveAgentTools：汇总所选 MCP、Toolkit、Skill
  → runDedicatedSandboxTurn：模型、唯一沙箱、短期运行授权
  → runSandboxAgentTurn：检查运行状态、准备包与 Skill 文件
  → runPi / runClaudeCode / runDsh
  → 沙箱内原生 CLI；模型与 MCP 请求回调 ToolPlane
  → 解析原生事件，输出文本 / 工具活动 / 用量 / 命令目录
  → 调用方负责 UI 流、Work 状态和平台消息持久化
```

创建与更新入口见 [`actions.ts`](../src/lib/agents/actions.ts) 和 [`mutations.ts`](../src/lib/agents/mutations.ts)。配置事务校验模型和资源是否属于同一工作区；未选择沙箱时可以创建专属沙箱记录。**记录创建成功不代表运行时已就绪**，执行时仍要检查沙箱关联、网络和实际运行状态。

[`runDedicatedSandboxTurn()`](../src/lib/agents/sandbox-turn.ts) 要求有效模型、恰好一个属于该 Agent 工作区的 Docker 沙箱，拒绝 `network=none` 或不匹配的显式 `sandboxId`。它去重并筛选运行中的 MCP deployment，为这一执行上下文签发运行时 Token，然后调用低层执行器。

[`sandbox-runtime.ts`](../src/lib/agents/sandbox-runtime.ts) 再次验证关联和 deployment 的有效运行状态，将工作目录限制在 `/workspace` 下，排除沙箱自身的 MCP deployment，准备运行时包与所选 Skill，再按种类分流。底层 Docker 操作接入运行时所有权与取消信号；不存在“沙箱不可用就改为宿主机执行”的降级路径。

## 3. 源码导航

| 要理解或修改的行为 | 主要入口 |
|---|---|
| runtime kind、能力、工具禁用分组 | [`runtime-kind.ts`](../src/lib/agents/runtime-kind.ts) |
| 已保存消息、渠道调用 | [`message-service.ts`](../src/lib/agents/message-service.ts) |
| 直接聊天的 UI 流 | [`chat/route.ts`](../src/app/api/v1/agents/%5BagentId%5D/chat/route.ts)、[`ui-stream.ts`](../src/lib/agents/ui-stream.ts) |
| Work 调度、工作目录、事件与取消 | [`work/coordinator.ts`](../src/lib/work/coordinator.ts) |
| 平台子 Agent 委派 | [`run.ts`](../src/lib/agents/run.ts) |
| 执行上下文与 Docker 适配 | [`sandbox-turn.ts`](../src/lib/agents/sandbox-turn.ts)、[`sandbox-runtime.ts`](../src/lib/agents/sandbox-runtime.ts) |
| Pi / CC 原生会话进程 | [`native-runtime-session.mjs`](../scripts/native-runtime-session.mjs) |
| DSH 原生会话与命令插件 | [`dsh-runtime-driver.mjs`](../scripts/dsh-runtime-driver.mjs) |
| 运行授权与当前资源绑定复核 | [`runtime-access.ts`](../src/lib/agents/runtime-access.ts)、[`runtime-grant.ts`](../src/lib/agents/runtime-grant.ts) |
| 原生命令与平台会话操作 | [`runtime-commands.ts`](../src/lib/agents/runtime-commands.ts)、[`runtime-command-service.ts`](../src/lib/agents/runtime-command-service.ts)、[`conversation-operations.ts`](../src/lib/agents/conversation-operations.ts) |

## 4. 模型代理和凭据边界

三者的模型地址不是直接拼接真实 provider key 的上游地址，而是 ToolPlane 的 `/api/v1/agent-runtime/model/{providerId}`。MCP 地址为 `/api/v1/agent-runtime/mcp/{deploymentId}/rpc`。

[`runtime-access.ts`](../src/lib/agents/runtime-access.ts) 用平台签名 Token 绑定 `workspaceId`、`agentId`、`sandboxId`、`providerId` 和 deployment 允许清单。当前 turn 签发 55 分钟有效期，验证器限制最大 TTL 为 60 分钟；这是运行授权，不是用户 API Token 或 Toolkit 安装 Token，也不是按单个模型 ID 绑定的凭据。

[模型代理](../src/app/api/v1/agent-runtime/model/%5BproviderId%5D/%5B%5B...path%5D%5D/route.ts)与 [MCP 代理](../src/app/api/v1/agent-runtime/mcp/%5BdeploymentId%5D/rpc/route.ts)校验授权及当前资源关系。模型代理移除客户端凭据和 Cookie 等头，再从平台侧配置添加上游认证。不要把运行 Token、真实 provider key 或数据库凭据写入用户可见的输出和诊断材料。

| 原生调用方 | 模型协议适配 |
|---|---|
| Pi | `buildPiModelsConfig()` 将 provider format 映射到 `openai-completions`、`openai-responses` 或 `anthropic-messages` |
| Claude Code | CLI 使用 Anthropic 形式的请求；当配置的 provider 不是 Anthropic 时，ToolPlane 的 [`anthropic-gateway.ts`](../src/lib/agents/anthropic-gateway.ts) 适配 `/v1/messages` 和 `/v1/messages/count_tokens` |
| DSH | `buildDshPatch()` 配置 `llm-pi-ai`、默认 provider/model 和上述协议映射 |

CC 的兼容网关不是“完整实现所有 Anthropic API”的承诺；兼容范围以当前请求 schema、事件转换和测试为准。其 `count_tokens` 兼容响应使用估算，不能当作上游提供的精确计费数据。

回调地址由 `sandboxRuntimeOrigin()` 解析。排障首先检查 `TOOLPLANE_RUNTIME_ORIGIN` 和容器到平台的实际连通性；本地 loopback 会转换为 `host.docker.internal`。该函数返回 URL 的 origin，不保留配置 URL 的路径前缀，因此不能假设在这里加子路径就能配置带前缀的回调路由。

## 5. Pi：显式配置、MCP 扩展与 RPC 会话

`runPi()` 生成专属 `models.json`，通过 `PI_CODING_AGENT_DIR` 定位 Agent 状态目录，以 `TOOLPLANE_RUNTIME_TOKEN` 访问模型代理。启动时关闭默认 extensions、skills、prompt templates、themes 和 context files 的自动发现，再显式加载本次所选 Skill 目录与 ToolPlane MCP 扩展。

- 有 `runtimeSessionId` 时使用 `--mode rpc`，交给原生会话驱动保持 CLI；没有时使用 `--mode json --no-session`，输入本次构造的 transcript。
- `piMcpExtensionSource()` 是显式 `--extension` 加载的桥接代码，发现 MCP 工具、注册名称、调用 JSON-RPC，并对请求、响应、schema 大小和注册数量做限制。
- 内置工具禁用项经 `normalizeDisabledBuiltinTools()` 校验后传给 `--exclude-tools`。这与远端 MCP 工具的授权策略是不同层。
- `parsePiStreamLine()` 提取文本、推理活动、工具调用、错误和上下文用量；原生 `/compact [focus]` 被会话驱动转换为 Pi 的 `compact` RPC。

[`native-runtime-session.mjs`](../scripts/native-runtime-session.mjs) 为 Pi 使用 `SessionManager` 进行首次历史导入，随后由 CLI 维护 JSONL 会话。原生压缩后不重新导入完整平台历史。`--offline` / `PI_OFFLINE` 不意味着无需网络：首次包安装以及模型、MCP 代理请求仍需要可达的网络路径。

## 6. Claude Code：stream-json、Skill 插件与会话恢复

`runClaudeCode()` 使用 `buildClaudeRuntimeArgs()` 生成 `--bare --print --verbose --output-format stream-json` 等参数；持久会话还启用 `--input-format stream-json`，无会话模式则使用 `--no-session-persistence`。系统提示词使用 `--append-system-prompt`，所选 Skill 使用显式 `--plugin-dir`。

MCP 配置由 `buildClaudeMcpConfig()` 生成，在存在所选 MCP 时以 `--mcp-config` 和 `--strict-mcp-config` 传入；认证头里是短期运行 Token，不是真实模型密钥。`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 在这个适配器里同样承载运行 Token，`ANTHROPIC_BASE_URL` 指向平台代理。

CLI 以 `CLAUDE_RUNTIME_USER`（当前 `1000:1000`）运行。准备步骤会对 `/workspace` 执行递归所有权调整，因此不能将其视为对任意宿主机挂载都无副作用的通用脚本。`HOME` 和 `CLAUDE_CONFIG_DIR` 指向 Agent 的独立状态目录。

持久模式复用与 Pi 相同的 socket 驱动，但协议不同：输入和输出是 CC 的 stream-json；新会话用 `--session-id`，已有会话用 `--resume`。首次旧历史导入依赖所固定 CLI 版本的 resume 文件格式，升级时必须单独验证，不能假定所有版本兼容。

`parseClaudeRuntimeMetadata()` 从 `system/init`、`commands_changed` 读取运行中的命令目录，从 `result` 提取 usage；`parseClaudeStreamLine()` 处理 partial messages、文本、工具和错误。`/clear`、`/compact [focus]`、`/context`、`/usage` 由原生 CLI 执行，不用同名宿主机逻辑模拟。

## 7. DSH：headless profile、插件驱动与持久化状态

`runDsh()` 每次准备 patch、输入文件和带随机前缀的事件插件，再运行 `dsh --profile headless --patch ...`。`buildDshPatch()` 配置模型、system prompt、Skill 根目录，以及 `@deepseek-ai/dsh-mcp-client` 的 streamable-http 连接。

有 `runtimeSessionId` 时，patch 关闭默认 `headless-runner` 并加载 [`dsh-runtime-driver.mjs`](../scripts/dsh-runtime-driver.mjs)。驱动等待依赖就绪，按 `toolplane-<runtimeSessionId>` 查找会话，通过 `agents.resume()` 或 `agents.create()` 建立 Agent，只在首次创建时导入历史。随后它执行注册命令或发送 followup，等待 idle，检查 `turn/end` 是否正常完成，最后在 `finally` 中 flush 会话。

**DSH 这里不是 Pi/CC 那种跨轮次驻留的 socket CLI。**原生进程可以退出，下次通过 `DSH_HOME` 下的持久化数据恢复会话和 goal；未传会话 ID 时保留普通 headless 路径。

事件插件输出带本次随机前缀的 JSON 行，`parseDshEventLine()` 只解析匹配的活动事件；命令目录和命令结果使用同一前缀通道。适配器的上下文用量当前为估算，不应当作精确计费数据。

DSH 的内置工具禁用映射到插件行：例如多个文件工具共用 `tool-fs`，禁用其中一个映射项可能禁用整组插件能力。修改 UI 或策略时要保持这个实际粒度，不要承诺逐工具隔离。`/goal` 及其参数由原生命令注册表解释。

## 8. 会话复用取决于入口

以下是本次核对到的调用参数，不是对所有未来入口的统一假设：

| 调用方 | 传给 dedicated runner 的 `runtimeSessionId` | 行为 |
|---|---|---|
| `message-service.ts` | `conversation.id` | 使用对应原生会话 |
| `work/coordinator.ts` | `work.conversationId` | 使用对应原生会话；传入 Work 工作目录 |
| `runtime-command-service.ts` 的普通会话命令 | `conversation.id` | 对该原生会话执行命令；Work 命令则入队交给 coordinator |
| `agents/[agentId]/chat/route.ts` 的 dedicated 分支 | 有保存会话时传 `conversationId` | 复用对应原生会话，同时限定协作任务查询范围 |
| `run.ts` 的 dedicated 子 Agent 分支 | 未传 | 单次委派，不复用父对话的原生会话 |

因此，数据库中的平台消息、Hermes 的运行会话字段和这里的原生会话键不能混用。直接 `/chat` 现在为已保存对话传入会话 ID；没有保存会话的请求仍没有持久化原生会话保证。

Pi/CC 驱动按 `statePath` 的哈希生成沙箱内 Unix socket。一个 socket 同时只接一个请求；配置签名变化或进程达到复用年龄时，在下一次请求重启并恢复；空闲时也会退出。状态通过临时文件加 rename 保存。已经导入过的原生历史丢失时，驱动会报错，不能靠重放完整平台历史掩盖丢失，否则可能撤销先前的压缩语义。

[`runtime-commands.ts`](../src/lib/agents/runtime-commands.ts) 提供最小命令目录，并只为 CC/DSH 合并当前 runtime/session 上报的动态目录；`new`、`help` 等宿主命令不混入其中。[命令服务](../src/lib/agents/runtime-command-service.ts) 检查工作区、Agent、Conversation、运行时是否变化以及忙碌状态；未知命令不会悄悄变成普通模型提示词。

## 9. 包、Skill 和 MCP 的文件布局

下面是概念布局；具体文件名由执行器生成，不能把含凭据的文件整体复制到 issue 或日志中：

```text
/workspace/.toolplane/
  runtime-packages/<runtime-and-version>/  # 固定版本的 CLI 与依赖
  npm-cache/pnpm-store/                    # 安装缓存
  runtime-tmp/                            # 每轮或会话使用的桥接配置和输入
  runtimes/<kind>/agents/<agentId>/        # Agent 状态根目录
    skills/                               # Pi/DSH 的所选 Skill 根目录
    sessions/                             # Pi/CC 驱动状态；其他原生数据由 CLI 管理
```

CC 的 Skill 根目录自身是插件目录，包含 `.claude-plugin/plugin.json` 和 `skills/<skill>/SKILL.md`，因此会出现额外一层 `skills/`。`materializeSandboxSkills()` 使用摘要跳过未变化内容，重建时写入 Markdown 与附加文件；它不是用户电脑上 `plugin/sync-client.ts` 的可恢复 Toolkit 同步事务，不能把两者的恢复保证混为一谈。

运行时版本、安装目录和可执行文件统一定义在 [`SANDBOX_RUNTIME_PACKAGES`](../src/lib/agents/sandbox-runtime.ts)。`ensureRuntimeInstalled()` 在目标容器里检查二进制并使用固定版本 `pnpm add`，控制安装脚本允许清单，并在同一应用进程内合并并发安装等待。沙箱镜像需要具备执行器要求的 Node、pnpm 和系统能力；升级根项目依赖不会自动升级已有沙箱里的 CLI。

关联平台子 Agent 时，执行器另外注入受限的协作 MCP；其任务、允许清单和用户授权见 [Agent 间协作](./AGENT_COLLABORATION.zh-CN.md)。它不通过旧的宿主工具集合隐式注入，也不等于原生 CLI 内部子 Agent。

所选 Skill 来自平台资源解析，额外文件路径经过安全路径处理；三者均通过自己的文件/执行工具消费 Skill。`buildAgentToolSet()` 中的宿主工具、知识库工具、平台子 Agent 包装器不会仅因创建了 dedicated runner 就自动注入原生 CLI；原生 CLI 自带的子 Agent 能力也不等于 ToolPlane 的子 Agent 关系。

附件只在提供有效沙箱 `runtimePath` 时转成可读取路径提示；没有路径时 transcript 会说明字节未挂载。不要将“消息带 file/image part”误认为文件已经进入该 Docker 沙箱。

## 10. 事件、用量和持久化责任

执行器统一回调 `onTextDelta`、`onActivity`、`onContextUsage`、`onCommands`、`onUsage`，但不是每个运行时都会提供每一类精确数据。工具活动补充 deployment 与原始工具名称映射，便于区分原生内置工具和远端 MCP。

[`ui-stream.ts`](../src/lib/agents/ui-stream.ts) 将活动转成前端的 text/reasoning/tool 消息块；Work 则由 coordinator 发布输出和保存状态。命令目录、命令结果和 runtime usage 使用 `runtime-commands.ts` 定义的消息 part。**前端流格式统一不代表底层执行引擎相同，也不代表低层执行器负责数据库消息落库。**

Pi/CC 在收到可用原生统计时使用它，否则相关路径会回退估算；DSH 当前回调估算值。上游兼容网关本身的估算、上下文窗口估算与计费 usage 也要分别理解，不要仅凭显示的 token 数推导账单。

## 11. 安全、取消与故障排查

这些 CLI 在专属沙箱中采用非交互执行：Pi 使用 `--no-approve`，CC 使用 `--dangerously-skip-permissions`，DSH 设置 `DSH_PERMISSION_MODE=danger-full-access`。这些是现有实现的边界，不是推荐在宿主机照抄的启动命令。**原生工具禁用和 MCP scope 不能替代容器、挂载及网络隔离，也不能假定每个 CLI 内置工具调用都会经过平台逐项审批。**

`runTrackedDockerExec()` 记录容器内 PID、串行处理输出回调，并组合请求取消与 owner 取消信号。超时、取消或输出超限时尝试终止容器内进程树并清理 Docker exec；这是有界清理机制，不是对任意外部副作用的事务回滚保证。Pi/CC 驱动还处理 socket 断开与原生子进程退出。运行时单所有者、readiness、非正常退出后的人工恢复见[运行时运维](./RUNTIME_OPERATIONS.zh-CN.md)，不要绕过恢复标记来抢占仍在运行的旧实例。

| 症状 | 优先检查 |
|---|---|
| 提示必须分配一个沙箱 / 沙箱未运行 | AgentSandbox 数量、工作区归属、Docker 类型、network 和有效 deployment 状态 |
| 首次启动失败 | `SANDBOX_RUNTIME_PACKAGES`、容器 Node/pnpm、包源连通性、安装脚本和文件权限 |
| 模型或 MCP 返回 401/403 | Token 是否过期、provider/deployment 是否仍属于当前授权、Agent 与沙箱绑定是否变化；不要直接改用个人 Token |
| 原生会话 busy 或历史丢失 | 调用入口实际传入的 session ID、工作目录、原生状态目录、同一会话是否仍在执行；必要时恢复匹配的沙箱数据或新建对话 |
| `/compact` / `/goal` 不可用或参数错误 | 当前 runtime 的命令目录、持久模式是否启用、原生注册表和 CLI 参数要求 |
| Skill 或文件不可见 | 所选资源是否被解析、插件目录层级、摘要、文件是否实际挂载，而不是只存在平台附件记录 |
| 有 HTTP 响应但执行被阻止 | runtime readiness 与单所有者状态；进程存活不等于已完成运行时恢复 |

日志采集策略见[可观测性](./OBSERVABILITY.zh-CN.md)。日常优先检查关联 ID、状态、耗时与失败类型；采集 Agent 内容需显式、限时授权，不要把原生 stdout、提示词或私有配置全量贴到公开 issue。

## 12. 验证和演进约束

无需启动真实 CLI 的重点回归入口：

```bash
pnpm vitest run tests/unit/agent-sandbox-runtime.test.ts tests/unit/agent-sandbox-turn.test.ts
pnpm vitest run tests/unit/agent-runtime-access.test.ts tests/unit/agent-runtime-proxy.test.ts tests/unit/agent-anthropic-gateway.test.ts
pnpm vitest run tests/unit/documentation-contracts.test.ts
```

真实原生会话测试是显式开启的。需要可丢弃、已安装对应固定版本运行时的测试容器，以及容器到测试进程的网络连通性；不要指向生产 Agent 沙箱。下面的容器名是示例，测试不会为你创建或准备该容器：

```bash
TOOLPLANE_NATIVE_COMMAND_SANDBOX=toolplane-runtime-test \
TOOLPLANE_NATIVE_COMMAND_KIND=pi \
  pnpm vitest run tests/integration/native-runtime-session.test.ts

TOOLPLANE_COMMAND_SANDBOX_TEST=toolplane-runtime-test \
  pnpm vitest run tests/integration/dsh-command-driver.test.ts
```

第一条可将 kind 改为 `claude-code` 或 `dsh`。测试实现见[原生会话测试](../tests/integration/native-runtime-session.test.ts)与 [DSH 命令测试](../tests/integration/dsh-command-driver.test.ts)；未设置环境变量时它们会跳过，不能把普通 CI 成功说成真实 CLI 会话已验收。

升级运行时或新增适配器时，在同一 PR 检查能力注册表、包定义、provider 映射、事件解析、Skill/MCP 投影、首次历史导入与恢复、原生命令和取消路径。先补针对性测试，再更新本页两个语言版本；不要为复用外观把三种原生会话协议强行当成一个实现。