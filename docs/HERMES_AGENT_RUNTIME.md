# Hermes Agent Runtime

> **English**: [HERMES_AGENT_RUNTIME.en.md](./HERMES_AGENT_RUNTIME.en.md)

本文说明 ToolPlane 托管 Hermes Agent 的配置所有权、持久化、网络和运维边界，面向平台开发者与部署者。配置行为以 [`hermes/config.ts`](../src/lib/agents/hermes/config.ts) 和 [`hermes/runtime.ts`](../src/lib/agents/hermes/runtime.ts) 为准。

## 1. 控制面与运行时

ToolPlane 拥有 workspace、权限、模型服务商配置、MCP/Skill 选择、频道凭据、生命周期、审计和 UI。Hermes 作为一种可选 runtime，负责会话、长期记忆、工具循环、文件工作区、Skills、Cron 和其他 Hermes 原生能力。

平台当前 runtime 标识为 `pi`、`claude-code`、`dsh`、`hermes`，不是旧的 Native/Hermes 二选一。Pi、Claude Code、DSH 使用专属沙箱；Hermes 为每个 Agent 创建专属容器、持久卷和 runtime 凭据。内部 `native.ts` 文件不代表可选择 `runtime: "native"`。完整清单见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

Hermes 不是 ToolPlane 的数据库或授权源。容器不获得 Postgres 访问或用户级 ToolPlane API Token；但是所选模型服务商的密钥会写入该 Agent 的私有 Hermes 配置卷。这与“不向公共接口暴露凭据”是两个不同边界。

## 2. 创建与升级

控制台 New Agent 先选择 runtime。选择 Hermes 后，配置一个或多个 model provider、MCP deployments、已安装 Skills、Toolkits，以及 Hermes Docker image；具体模型分工由 Hermes 配置。Pi、Claude Code、DSH 则使用单 provider / model 绑定，不应套用 Hermes 的多选流程。

Agent Control MCP 的 `create_agent` 只开放 `pi` 和 `hermes`，并不开放控制台全部 runtime。它也不接受调用者自选 Hermes 镜像，而使用实例管理员的配置；参见 [AGENT_CONTROL_MCP.zh-CN.md](./AGENT_CONTROL_MCP.zh-CN.md)。

Hermes 的资源链路为：

```text
Agent
  -> AgentRuntime(kind=hermes)
  -> Sandbox(kind=hermes)
  -> Deployment(source=sandbox)
  -> Docker named volume mounted at /opt/data
```

数据库资源建立和 Docker 资源准备是不同操作，不应把 Docker volume 描述成受数据库事务原子提交保护的记录。未选择 provider 时 runtime 保持 `setup_required`；选择至少一个 provider 并保存后，同步 provider inventory 并启动 gateway。

### 镜像版本

控制台支持选择 ToolPlane 提供的 Hermes 镜像版本或完整镜像引用。生产环境应避免把可变的 `latest` 当成不可变版本；需要更严格的可复现性时使用镜像 digest。实例默认镜像由 `TOOLPLANE_HERMES_IMAGE` 配置，Compose 部署修改 `.env` 后需重新创建应用容器。

已有 Agent 在 **Settings → Hermes → Upgrade & restart** 升级。ToolPlane 先拉取目标镜像；拉取失败不停止当前 runtime。拉取成功后重建容器并重新投影配置。即使仍选同一个 `:latest`，也会重新拉取和重建。`/opt/data` 卷保留，因此会话、记忆、工作区、本地 Skills 和附件保留；正在执行的请求可能中断。

镜像选择写回 `AgentRuntime`、受管 `Sandbox` 与 `Deployment`，避免后续同步回退。消息频道使用独立的 Node 适配器，不依赖在 Hermes 镜像中安装 Python 消息频道适配器。

### 导入已有 `.hermes` 主目录

在 **Sandboxes → New sandbox → Import .hermes archive** 上传 ZIP。归档可以以单个 `.hermes/` 为根，也可以直接包含主目录内容。此流程建立上述 Agent/runtime/Sandbox 链路，不会创建脱离 Agent 的通用 Sandbox。

[`archive-limits.ts`](../src/lib/agents/hermes/archive-limits.ts) 定义：压缩包默认 48 MiB，管理员可配置 1–10,240 MiB；解压总量默认上限 256 MiB，随调高的上传上限增长，最高 10 GiB。它使用 MiB/GiB（二进制单位），不要与普通附件的 MB/GB 混淆。

浏览器把 ZIP 作为原始请求体流式传入暂存存储，不经 Server Action、multipart 或全量 `arrayBuffer()`。Compose 默认把 `toolplane_imports` 挂载到 `/var/lib/toolplane/imports`；可通过 `TOOLPLANE_HERMES_ARCHIVE_VOLUME=/srv/toolplane/imports` 使用更大的宿主机目录，并确保容器内 `node` 用户可写。

ZIP、解压树、初始化副本和最终卷可能同时占用空间；10 GiB 导入应为约 40 GiB 的临时峰值规划容量。实例一次只执行一个归档导入，预检空间，并清理崩溃遗留或过期租约的暂存文件。该租约用于单应用进程崩溃恢复，不是多实例共享暂存卷的分布式锁。

归档检查路径、重复/Unicode 冲突、链接/特殊文件、加密条目、权限、条目数量、大小、压缩比及检查时限。相对且不逃出根目录的链接可保留，旧主机的绝对链接被丢弃，其余不安全链接被拒绝。归档限制还包括最多 200,000 个条目、1,024 个链接，以及 `config.yaml` / `.env` 各 4 MiB；高度可压缩的缓存文件有受限例外。不要把 ZIP 上传大小上限当作唯一检查。

反向代理必须为 `POST /api/v1/workspaces/:slug/sandboxes/hermes-import` 放宽 body 大小和上传/读取时限，并关闭请求缓冲。生产启动器默认的 `TOOLPLANE_HTTP_REQUEST_TIMEOUT_MS` 为四小时（配置不低于一分钟），覆盖原始请求体接收；完整 Route Handler 的预算是 50,400 秒，即十四小时，包含后续检查、拷贝和同步。其他路由仍应保留合理的代理连接与速率限制。`pnpm dev` 不能替代生产启动器的大文件验证。

上传是单请求流，不支持断点续传。页面复用导入 ID：响应丢失后的重试可返回已完成结果，未完成的旧导入需先检查或清理。归档中的 ToolPlane 受管键清单、`skills/toolplane-agent/` 和 `skill-bundles/toolplane-agent.yaml` 被移除后重新生成；原有会话、记忆、本地 Skills 和其他原生设置写入私有卷。

导入后 runtime 默认停止，不自动选择 provider。确认模型配置并显式启动后，归档里的插件、hook 或 MCP 才可能运行。只能导入可信归档：其中可能包含凭据、会话及可执行配置。

## 3. 配置投影

```text
/opt/data/
├─ config.yaml
├─ .env                         # Hermes 与 ToolPlane 变量的合并结果
├─ .toolplane-env-keys.json      # ToolPlane 受管键清单
├─ sessions/                    # Hermes 管理
├─ memories/                    # Hermes 管理
├─ workspace/
│  └─ attachments/
├─ skills/
│  └─ toolplane-agent/<skill>/
│     ├─ SKILL.md
│     └─ ...bundle files
└─ skill-bundles/
   └─ toolplane-agent.yaml
```

普通控制台 Hermes Agent 的同步管理范围包括：

- `skills/toolplane-agent` 与 `skill-bundles/toolplane-agent.yaml`。
- `.env` 中 ToolPlane 管理的环境变量和 runtime API key。
- `config.yaml` 中以 `toolplane-` 命名的 provider 条目、`agent.max_turns`、`approvals`、`tool_loop_guardrails`、`platforms.api_server.enabled` 和 `mcp_servers.toolplane`；主模型的初始化与失效回退另见下文。

这些是 YAML 字段和命名约定，不是把所有配置都放进一个名为 `toolplane` 的顶层对象。结构化合并保留未受管的 memory、cron、plugins、其他 MCP、原生设置，以及会话、记忆、本地 Skills 和用户工作区。

环境变量以 `KEY=value` 编辑。同步使用 `.toolplane-env-keys.json` 只替换或删除曾由 ToolPlane 管理的键，保留其他变量及注释；`.env` 和清单以 `0600` 权限原子写入，保存后的同步和重启使变量生效。

### 系统提示词的所有权

普通控制台 Hermes Agent 的 `agent.system_prompt` 由 Hermes Dashboard/终端管理，ToolPlane 不把普通 `Agent.systemPrompt` 投影进去。

**公共 Endpoint runtime 是例外**：`renderManagedHermesConfig` 会传入已发布 revision 的 `systemPrompt`，并设置 `publicRuntime`；生成器额外限制内置 toolsets、API server 的工具入口与 delegation。不能把控制台的“不改系统提示词、保留原生能力”承诺扩展到隔离的公共执行 runtime。参见 [AGENT_PUBLIC_API.zh-CN.md](./AGENT_PUBLIC_API.zh-CN.md)。

### Model providers

Hermes 使用多选 `AgentModelProvider`，以稳定的 `toolplane-...` key 写入 `providers`。当前投影字段是 `transport`，不是旧说明中的 `api_mode`：

| ToolPlane provider format | Hermes 字段 |
|---|---|
| `openai` | `transport: chat_completions` |
| `openai-responses` | `transport: codex_responses` |
| `anthropic` | `transport: anthropic_messages` |

条目还包含 `name`、`api`、`api_key`、`models`，有缓存模型时写入 `default_model`，无缓存模型时启用 `discover_models`。模型列表、base URL 和真实 provider key 写入专属卷，不写入 Deployment JSON、Sandbox JSON 或 Docker inspect environment。

首次配置无有效主模型时，选第一个有缓存模型的 provider/model 作启动默认值。Hermes 自行配置具体模型分工；同步保留仍有效的主模型。若 ToolPlane 管理的 provider 被移除，或非空缓存目录不再包含当前模型，会回退到剩余 provider 的启动默认值；不能只描述为“删除 provider 才回退”。未受管的 provider 条目保留。

Pi、Claude Code、DSH 使用 `Agent.providerId + Agent.model` 的单 provider / model 绑定，不使用 Hermes 的多选投影。

### MCP 与 Skills

ToolPlane 投影一个聚合 MCP 入口，而不是禁止 Hermes 拥有其他自行配置的 MCP：

```text
POST /api/v1/agent-runtimes/:runtimeId/mcp
Authorization: Bearer <runtime-scoped-token>
```

该入口只聚合 Agent 授权的部署，包括 Toolkit 派生绑定，再路由到现有 MCP supervisor 并写 `LogEvent`。其他未受管的 `mcp_servers` 配置由结构化合并保留。

直接绑定和 Toolkit 派生的 Skills 经 `resolveAgentTools()` 去重，只同步可供 Agent 调用的项目。技能正文与 bundle 附件保留，写入平台专属的 `skills/toolplane-agent`，不清除 Hermes 自建 Skills。

## 4. 网络、密钥与持久化

Hermes 使用 `mcp-sandbox` egress 网络，不加入 ToolPlane/Postgres 内部网络；API server 只在容器内 `127.0.0.1:8642` 监听，Dashboard 在 `127.0.0.1:9119` 监听，不发布这些容器端口。supervisor 通过受控的 `docker exec curl` 代理访问。

容器移除默认 capabilities，再补充启动和文件所有权所需能力，并设置 CPU、内存与 PID 限制。默认启用 `no-new-privileges`，`Allow sudo` 是明确的例外，见终端部分。

runtime API key 与聚合 MCP token 通过 `deriveHermesRuntimeToken(runtimeId, purpose)` 从实例密钥派生。`hermes-api` 与 `toolplane-mcp` 是不同用途，不能互换；数据库不保存明文 runtime token。这不意味着 provider key 不存在于私有卷。

托管 runtime Sandbox 与 Agent 一一绑定，不出现在通用 Sandbox 列表，不能绑定给别的 Agent。独立管理面板提供名称、环境变量与快照控制，启动/停止/删除仍遵循 Agent runtime 生命周期。

### 快照

快照复制 `/opt/data` named volume，包含 workspace、sessions、memories、attachments、本地 Skills 与原生配置；不包含容器可写层，也不回滚 ToolPlane 数据库的 `Conversation` / `AgentAttachment`。它不是完整的逻辑 Agent checkpoint；恢复旧卷后数据库元数据可能指向已不存在的文件或会话。

创建或恢复快照先进入 maintenance gate，排空已进入的聊天与附件写入、拒绝新写入，再停止 runtime 并复制。恢复后重新投影当前 Agent 的 provider、MCP、Skills 与环境变量；之前运行的 runtime 才重新启动。Hermes 不通过通用 Sandbox clone 直接克隆，需要副本时使用 Agent clone 流程。通用 Docker 快照的恢复与清理失败状态见 [SANDBOXES.zh-CN.md](./SANDBOXES.zh-CN.md)。

### Dashboard

Agent 设置的 Hermes 页嵌入原生 Dashboard。浏览器经 runtime-scoped 签名 capability、平台 dashboard 路由、独立来源的 Dashboard broker 与受控 sandbox proxy 访问容器 loopback，而不直连容器端口。

```text
ToolPlane Agent page
  -> runtime-scoped capability（8 小时）
  -> /api/v1/agent-runtimes/:runtimeId/dashboard/:capability/*
  -> 307 到独立来源 http://<host>:9332
  -> 绑定父页面来源的 capability
  -> Dashboard broker -> sandbox proxy
  -> docker exec curl 127.0.0.1:9119
```

独立来源允许 iframe 的 `allow-same-origin` / `localStorage`，同时与 ToolPlane 页面隔离。broker 不转发平台 Cookie、Authorization 或用户 Token，并约束 `connect-src` 与 `frame-ancestors`。代理可转发 Hermes 自己的 `X-Hermes-Session-Token`。WebSocket 在 capability 和 Origin 检查后通过 `docker exec --user hermes` 中的帧桥转发，不发布容器端口。

本地 broker 默认 `0.0.0.0:9332`。HTTPS 部署配置不同于 `NEXT_PUBLIC_APP_URL` 来源的 `HERMES_DASHBOARD_PUBLIC_URL`，如 `https://hermes.example.com`，并代理到 `HERMES_DASHBOARD_PORT`。平台管理的配置仍以 ToolPlane 为准；普通控制台 runtime 的其他 Skills、模型分工和系统提示词由 Hermes 管理。

### Terminal 与 Allow sudo

```text
/api/v1/agents/:agentId/terminal
  -> 验证用户成员资格及 URL 中 Agent 的 runtime
  -> 按需启动 Hermes
  -> supervised /terminal/session
  -> docker exec -w /opt/data/workspace
```

交互终端以镜像默认用户运行，当前托管镜像中为 root，不是自动以 `hermes` 用户启动整个 Shell。`hermes` CLI wrapper 才通过 `setpriv` 切换到 `hermes` 服务用户，保持 Hermes 状态文件可由服务用户维护。一个 Agent 的 terminal session ID 不能用于另一个 runtime。

聊天里的原生 shell 工具以 `hermes` 服务用户运行。开启 `Sandbox.config.allowSudo` 后，容器准备流程安装 sudo、配置 `hermes ALL=(ALL) NOPASSWD:ALL`，并移除 `no-new-privileges` 以允许 setuid sudo。虽然控制台终端和 MCP shell 本来就可作为 root 运行，**开启后聊天 runtime 的提权能力仍然扩大**，不能据此宣称安全边界不变。设置在重建容器后生效，持久卷保留；关闭后恢复默认限制。

## 5. 会话、频道与附件

### Console chat

ToolPlane 将 Hermes OpenAI SSE 转为 AI SDK UI stream；该前端协议不代表执行引擎仍是旧 Native runtime。

- `Conversation.id` 作为 `X-Hermes-Session-Id`。
- `agent:<agentId>:console:<conversationId>` 作为 `X-Hermes-Session-Key`。
- ToolPlane 保存 user/assistant message parts，Hermes 在自己的卷中维护完整 session 与 memory。

### Channels

消息从平台 Node 适配器进入 `runAgentChannelMessage`，按目标 Agent 的 runtime 分流，结果经 ToolPlane 响应契约返回适配器。稳定的 DM、群或 thread session key 传给 `X-Hermes-Session-Key`。

频道凭据不复制到 Agent 容器，避免重复消费。频道可在同工作区迁移到其他沙箱，并沿用凭据使用目标 runtime；Pi、Claude Code、DSH 不需要 Hermes 平台适配器。详见 [AGENT_MESSAGING_PLATFORMS.zh-CN.md](./AGENT_MESSAGING_PLATFORMS.zh-CN.md)。

### Attachments

ToolPlane 的 Hermes 文件上传入口为：

```text
POST /api/v1/agents/:agentId/attachments?filename=<name>&conversationId=<optional-id>
Content-Type: <file-mime-type>
<body: raw file bytes>
```

接口要求用户/会话授权并验证 workspace，且目标必须具有 Hermes runtime。它拒绝 multipart；使用原始请求体流式上传。`conversationId` 可省略；提供时必须属于 URL 中的 Agent。文件写入 `/opt/data/workspace/attachments/<conversation-id>/...`，未指定会话时使用 `attachments/inbox/`。

默认单文件限制为 **1,000,000,000 字节（十进制 1 GB）**。有效的数据库设置优先于 `TOOLPLANE_MAX_ATTACHMENT_BYTES`，再回退默认值。请求使用最终解析的 byte limit；管理员表单限制不应被误写为所有环境变量和手工数据库配置都被统一硬截断。部署者还应规划存储配额和代理限制，参见 [`attachment-limits.ts`](../src/lib/agents/attachment-limits.ts)。

`AgentAttachment` 保存 workspace、Agent、可选 conversation、runtime、MIME、大小和 storage path。上传流程不把文件内联成 Base64/JSON 模型消息；对话引用文件元数据与 runtime path。Hermes 后续仍可能通过工具读取文件内容，这不同于“文件内容永远不会进入模型上下文”。

上传与快照通过 runtime write lease 协调。代理的 body 上限应与配置一致，并关闭请求缓冲；上传接口的具体行为见 [`attachments/route.ts`](../src/app/api/v1/agents/[agentId]/attachments/route.ts)。

## 6. 生命周期

```text
setup_required -> provisioning -> running
       |               |             |
       +---------------+-------------+-> error
                                       -> stopped
```

`setup_required` 表示缺少可注入 provider；`provisioning` 表示镜像、卷或 gateway 正在准备；`running` 结合 supervisor 与健康检查判断；`stopped` 表示用户停止或进程结束；`error` 记录同步、Docker 或健康检查失败。

配置以 SHA-256 hash 去重，无变化保存不应触发重建；配置、MCP、Skill 或模型变化时重新投影并按需重建，保留持久卷。删除 Agent 或 workspace 需清理 supervisor、容器、快照和卷后再完成数据库删除；失败时应保留可重试状态，不把外部清理当作数据库回滚能够撤销的操作。

## 7. 验证与限制

审核 runtime 变更时，应分别检查普通控制台与隔离公共 Endpoint 的契约：配置所有权、provider 秘钥边界、跨 workspace/runtime 拒绝、会话作用域、原生配置保留、快照写入互斥、终端用户和删除失败恢复。

重点回归包括：同步不覆盖未受管的 Skills/配置；移除 provider 或模型后正确回退；公共 revision 的提示词和工具限制被投影；终端以镜像默认用户启动而 CLI 降权；恢复旧卷后重新投影当前授权；其他 Agent 的 capability、token、conversation 或 terminal session 不可复用。

当前文档不把历史计划清单当作“这些功能一定尚未实现”的证据。新增能力、支持的镜像及上游兼容性应以对应源码、测试和目标镜像为准。单进程 runtime/维护闸门约束仍适用；不能在未增加协调机制前直接横向扩容。

上游参考（目标镜像版本的契约可能不同）：

- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/docker.md>
- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md>
- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/web-dashboard.md>
- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md>
