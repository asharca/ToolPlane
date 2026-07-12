# Hermes Agent Runtime

## 1. 结论

ToolPlane 采用 `Hermes-first, ToolPlane-owned control plane`：

- ToolPlane 负责 workspace、权限、模型配置、MCP/Skill 选择、频道凭据、生命周期、审计和 UI。
- Hermes 作为可选的 Agent runtime，负责会话、长期记忆、工具循环、文件工作区、Skills、Cron 和其他 Hermes 原生能力。
- Native runtime 保留，适合轻量 Agent；Hermes runtime 为每个 Agent 创建独立容器、独立持久卷和独立 API key。

Hermes 不是 ToolPlane 的数据库或授权源。容器不能访问 Postgres，也不会获得用户级 ToolPlane API token。

## 2. 创建流程

New Agent 支持一次选择：

1. Runtime：`Native` 或 `Hermes`。
2. Model provider 和 model。
3. MCP deployments。
4. Installed Skills。
5. Toolkits。
6. Hermes Docker image（选择 Hermes 时）。

选择 Hermes 后，ToolPlane 在一个事务内创建：

```text
Agent
  -> AgentRuntime(kind=hermes)
  -> Sandbox(kind=hermes)
  -> Deployment(source=sandbox)
  -> Docker named volume
```

没有选择模型时，runtime 保持 `setup_required`，但 Agent、Sandbox 和配置卷已经创建。选择模型并保存后，ToolPlane 同步配置并启动 gateway。

## 3. 配置投影

ToolPlane 根据 Agent 当前授权关系生成 Hermes 的 `/opt/data` 内容：

```text
/opt/data/
├─ config.yaml
├─ sessions/                     # Hermes 管理，ToolPlane 不覆盖
├─ memories/                     # Hermes 管理，ToolPlane 不覆盖
├─ workspace/
│  └─ attachments/               # ToolPlane 上传，Hermes 读取
├─ skills/
│  └─ toolplane-agent/
│     └─ <skill>/
│        ├─ SKILL.md
│        └─ ...bundle files
└─ skill-bundles/
   └─ toolplane-agent.yaml
```

每次同步只替换 ToolPlane 管理的以下路径或字段：

- `skills/toolplane-agent`
- `skill-bundles/toolplane-agent.yaml`
- `config.yaml` 中的 `model`、`agent.max_turns`、`approvals`、
  `tool_loop_guardrails` 和 `mcp_servers.toolplane`

`config.yaml` 使用 YAML 结构化合并，Hermes Dashboard 写入的 memory provider、cron、plugins、
channels、其他 MCP 和其他原生配置会保留。Hermes 的 sessions、memories、cron、logs、plugins、
本地 Skills 和用户工作区也不会被同步操作删除。

`agent.system_prompt` 完全由 Hermes 管理。ToolPlane 不展示该字段、不把 `Agent.systemPrompt`
投影到 Hermes，也不会在配置同步时新增、修改或删除它。系统提示词只能通过 Hermes Dashboard
或 Hermes 终端修改。

### Model

ToolPlane 的 `ModelProvider` 被投影到 Hermes `model`：

- OpenAI compatible -> `api_mode: chat_completions`
- Anthropic -> `api_mode: anthropic_messages`
- model、base URL 和 provider API key 写入 Agent 专属持久卷

Provider key 不进入 Deployment JSON、Sandbox JSON 或 Docker inspect environment。

### MCP

Hermes 只看到一个聚合 MCP server：

```text
POST /api/v1/agent-runtimes/:runtimeId/mcp
```

该 endpoint 使用 Agent runtime 专属 Bearer token，只聚合该 Agent 直接绑定和 Toolkit 派生的 deployments。`tools/call` 再路由到现有 MCP supervisor，并继续写 RequestLog。

### Skills

直接绑定和 Toolkit 派生的 Skills 经 `resolveAgentTools()` 去重，只同步 `agentInvocable != false` 的项目。`SKILL.md` 和 bundle 附件保持原内容。

## 4. Runtime 网络和密钥

Hermes 容器：

- 使用 `mcp-sandbox` egress 网络，不加入 ToolPlane/Postgres 内部网络。
- 不发布 `8642` 或 dashboard 端口。
- Dashboard 在容器内启用，但只绑定 `127.0.0.1:9119`。
- root capabilities 全部移除，只恢复容器启动和文件所有权所需的最小集合。
- 启用 `no-new-privileges`、CPU、内存和 PID 限制。
- `/opt/data` 使用每个 Agent 独立的 Docker named volume。
- API Server 只绑定容器内 `127.0.0.1:8642`。
- 托管 runtime Sandbox 不出现在通用 Sandbox 列表，也不能绑定给其他 Agent；启动、停止和删除只能经 Agent runtime 生命周期执行。

ToolPlane supervisor 通过 `docker exec curl` 代理 Hermes HTTP。API key 和 MCP token 均由：

```text
HMAC-SHA256(AUTH_SECRET, runtimeId + purpose)
```

派生，因此数据库不保存明文 runtime token。`hermes-api` 和 `toolplane-mcp` 使用不同 purpose，不能互换。

### Hermes Dashboard

Agent 设置中的 `Hermes` 标签页嵌入官方 Dashboard，包括 Skills、Files、Sessions、Memory、Cron、
Plugins、MCP、Channels、Config、Keys 和 System 等原生页面。

浏览器不会直连容器端口。访问链路为：

```text
ToolPlane Agent page
  -> 8 小时、runtime-scoped 的签名 capability
  -> /api/v1/agent-runtimes/:runtimeId/dashboard/:capability/*
  -> 307 到独立来源 http://<host>:9332
  -> 绑定 ToolPlane 父页面来源的第二个签名 capability
  -> Hermes Dashboard broker
  -> supervised sandbox proxy
  -> docker exec curl 127.0.0.1:9119
```

Dashboard iframe 在独立端口来源上授予 `allow-same-origin`，使官方 Dashboard 可以使用
`localStorage`。它与 ToolPlane 页面仍受浏览器同源策略隔离；broker 不转发 ToolPlane Cookie、
Authorization header 或用户 API token，并返回 `connect-src 'self'`、父页面来源绑定的
`frame-ancestors` 等 CSP。这样即使 Agent 选择了自定义 Hermes 镜像，镜像提供的 Dashboard
JavaScript 也不能读取 ToolPlane 页面或调用其他 ToolPlane API。代理只转发 Hermes 自己注入的
`X-Hermes-Session-Token`。

本地开发默认监听 `0.0.0.0:9332`。HTTPS 部署需要配置
`HERMES_DASHBOARD_PUBLIC_URL=https://hermes.example.com`，并把该独立 TLS 来源反向代理到应用的
`HERMES_DASHBOARD_PORT`；该 URL 不能与 `NEXT_PUBLIC_APP_URL` 同源。

ToolPlane 投影的 `skills/toolplane-agent` 在 Dashboard 中属于平台托管内容；Hermes 自己创建的其他
Skills 可以直接编辑并持久化。模型和 `mcp_servers.toolplane` 始终以 ToolPlane 为准，系统提示词及
其他 Hermes 原生配置始终由 Hermes 管理。
Dashboard 自带的 Chat、事件流和实时控制台也通过独立 broker 转发；ToolPlane 的 Agent Chat 与
Terminal 仍作为平台原生入口保留。WebSocket 在 capability 与浏览器 Origin 校验后，通过
`docker exec --user hermes` 内的受控帧桥连接容器 loopback `127.0.0.1:9119`，不发布容器端口。

### Hermes Terminal

Agent 设置中的 `Terminal` 标签页提供完整交互式 Shell。浏览器使用 xterm，通过 Agent-scoped 的
HTTP + SSE API 连接到 supervisor：

```text
/api/v1/agents/:agentId/terminal
  -> verify user membership and URL Agent runtime
  -> auto-start Hermes runtime when needed
  -> supervised /terminal/session
  -> docker exec --user hermes -w /opt/data/workspace
```

终端 session 只能在 URL 中该 Agent 的容器内解析，不能拿一个 Agent 的 session ID 访问另一个
runtime。Shell 以 `hermes` 服务用户而不是 root 运行；ToolPlane 同步目录和上传附件也会修正为该用户
可读写，避免终端操作产生 Hermes 后续无法维护的文件。

## 5. Chat、记忆与附件

### Console chat

ToolPlane 将 Hermes OpenAI SSE 转换为现有 AI SDK UI stream，前端协议不变。

- `Conversation.id` -> `X-Hermes-Session-Id`
- `agent:<agentId>:console:<conversationId>` -> `X-Hermes-Session-Key`
- ToolPlane 继续保存 user/assistant message parts
- Hermes 在自己的 volume 中保存完整 session 和 memory

### Channels

频道继续使用 ToolPlane 已有的 Hermes platform adapters：

```text
Platform
  -> Hermes adapter runner
  -> ToolPlane channel endpoint
  -> runAgentChannelMessage
  -> Hermes Agent runtime
  -> ToolPlane response contract
  -> Hermes adapter send
```

频道的稳定 messaging session key 直接传给 `X-Hermes-Session-Key`，所以同一 DM、群、thread 可以获得稳定的长期记忆作用域。

频道凭据不会再复制到 Agent 容器；否则同一个 bot 会同时被 ToolPlane runner 和容器内 gateway polling，产生重复消费。增加新的 Hermes channel 时，只需扩展 ToolPlane platform catalog/runner，不改 Agent runtime。

### Attachments

Hermes OpenAI API 支持 inline image，但不支持 PDF/普通文件上传。因此 ToolPlane 提供：

```text
POST /api/v1/agents/:agentId/attachments
```

规则：

- 必须通过用户/session token 授权，并验证 Agent workspace。
- `conversationId` 必须属于 URL 中的 Agent。
- 单文件最大 10 MB。
- 文件写入 `/opt/data/workspace/attachments/<conversation>/...`。
- `AgentAttachment` 保存 workspace、Agent、conversation、runtime、MIME、大小和 storage path。
- 图片不超过 5 MB 时也以内联视觉 part 发送；其他文件通过 runtime path 交给 Hermes 的文件/terminal 工具读取。

## 6. 生命周期

Runtime 状态：

```text
setup_required -> provisioning -> running
       |               |             |
       +---------------+-------------+-> error
                                       -> stopped
```

- `setup_required`：没有完整 provider/model。
- `provisioning`：镜像、volume 或 gateway 正在启动。
- `running`：supervisor 存活且 `/health` 成功。
- `stopped`：用户停止或进程不再运行。
- `error`：同步、Docker 或 gateway health 失败，`lastError` 可见。

配置内容使用 SHA-256 hash 去重。无变化的 autosave 不重建容器；配置、MCP/Skill 选择或模型发生变化时，保留 volume，重建容器并启动新 gateway。

Agent 删除和 workspace 删除都会停止 supervisor、删除容器和 named volume，随后删除数据库记录。

## 7. 分阶段范围

### 本分支

- Agent runtime 数据模型和迁移
- New Agent runtime/model/MCP/Skill/Toolkit 选择
- Hermes 专属 Sandbox 与 Docker 生命周期
- Model、MCP、Skill 配置投影
- Console chat streaming adapter
- Channel message runtime 分流和 Hermes memory scope
- 附件上传、持久 workspace 和元数据
- 启动、停止、同步、状态和错误 UI
- 原生 Hermes Dashboard 的受控代理和 Agent 内嵌入口
- Agent-scoped Hermes 交互式终端
- Native runtime 兼容

### 后续

- Hermes `/v1/capabilities` 定期采集与版本兼容矩阵
- 可选的 ToolPlane 原生 Cron、memory、sessions、plugins 管理页
- 附件下载、删除、配额和病毒扫描
- Tool progress 事件映射到 AI SDK structured parts
- Runtime image allowlist、签名/SBOM 校验和升级策略
- 每 workspace/Agent 的 CPU、内存、磁盘和并发限额
- 更多 Hermes channel adapters 的 catalog onboarding

## 8. 验收标准

1. Native Agent 的 chat、tools、channels 和历史行为不变。
2. 创建 Hermes Agent 后只产生一个专属 runtime Sandbox。
3. Hermes 容器不能访问 ToolPlane DB，且宿主机没有公开 Hermes API 端口。
4. Runtime MCP token 不能访问其他 Agent 的 tools。
5. 修改 Agent 的 MCP/Skill/Toolkit 后，Hermes 配置可重复同步且不产生重复项。
6. 同一 conversation/channel session 重启容器后继续使用原 Hermes memory/session volume。
7. 跨 workspace provider、tool、conversation 和 attachment ID 被拒绝。
8. 删除 Agent/workspace 后无残留 supervisor、container 或 volume。
9. Dashboard 端口不发布，过期或其他 runtime 的 capability 无法访问该 Dashboard。
10. Dashboard 创建的本地 Skill、memory 和非 ToolPlane 配置在 Agent 工具重新同步后仍然存在。
11. Hermes Terminal 自动启动 runtime，以 `hermes` 用户进入 `/opt/data/workspace`，并隔离不同 Agent 的 session。

上游契约参考：

- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/docker.md>
- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md>
- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/web-dashboard.md>
- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md>
