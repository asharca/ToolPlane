# ToolPlane — 架构文档

> **English**: [ARCHITECTURE.en.md](./ARCHITECTURE.en.md)

> ToolPlane 是一个自托管 Agent 工具控制面，包含一个**独立的公开产品站**、一个**带真实市场和 MCP/Agent/Sandbox 运行时的登录后控制台**、一个**管理后台**，以及一套 **JSON API**。

---

## 1. 项目概述

本项目是一个 MCP（Model Context Protocol）与 Agent 生态平台，分四大功能区：

1. **公开产品站** `(site)` —— 只展示 ToolPlane 的产品优势与能力，不读取或镜像真实 MCP、Skill、Agent 市场数据。
2. **控制台 / Hub** `app/[workspace]` —— 登录后的工作区：浏览真实市场、部署 MCP 服务器、安装技能和智能体、把资源**自由组装**成 Toolkit、运行 Agent（Native / Hermes 沙箱）、聊天助手、知识库、Work 任务流、通过网关调用工具、查看可观测性。
3. **管理后台** `admin/` —— 管理员审核市场条目、管理目录（Servers/Skills/Agents/Assistants/分类）、用户、工作区、系统设置与日志审计。
4. **JSON API** `api/v1/*` + `api/openai/v1/*` —— MCP JSON-RPC 网关、技能下载、Toolkit/工作区 manifest 导出、Agent 公共 API、Agent Control MCP、渠道事件、管理接口，并暴露 `api/v1/openapi.json`。

核心特点：控制台里的 MCP 不是“假数据”——部署可以是内置子进程、远程 MCP（streamable-http / sse）或 Docker bridge 容器，网关把请求代理过去并记录可观测性。

各专题文档：

- [`docs/TOOLKIT_SYNC.md`](./TOOLKIT_SYNC.md) —— Toolkit 同步到 Claude Code、Codex、opencode、Hermes 的机制
- [`docs/SANDBOXES.md`](./SANDBOXES.md) —— Agent 沙箱的 Docker/Connector runtime
- [`docs/HERMES_AGENT_RUNTIME.md`](./HERMES_AGENT_RUNTIME.md) —— Hermes-first 的 Agent runtime 架构
- [`docs/AGENT_MESSAGING_PLATFORMS.md`](./AGENT_MESSAGING_PLATFORMS.md) —— Telegram/Lark(飞书)/QQ/微信/Discord/Slack 渠道
- [`docs/AGENT_PUBLIC_API.md`](./AGENT_PUBLIC_API.md) —— 已发布 Agent Endpoint 的公共 API 与部署拓扑约束
- [`docs/AGENT_CONTROL_MCP.md`](./AGENT_CONTROL_MCP.md) —— 工作区级 Agent Control MCP
- [`docs/OBSERVABILITY.md`](./OBSERVABILITY.md) —— 统一日志/审计模型与采集保留策略
- [`docs/WORKSPACES.md`](./WORKSPACES.md) —— 工作区成员、邀请与删除生命周期
- [`docs/UI_LIBRARY.md`](./UI_LIBRARY.md)、[`docs/RELEASES.md`](./RELEASES.md) —— 共享 UI 包与发布流程

---

## 2. 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Next.js 16.2.9（App Router + Turbopack）、React 19.2 |
| 语言 | TypeScript 5（Node >= 22）|
| 样式 | Tailwind CSS v4 + 共享 UI 包 `@asharca/ui`（npm 发布，源码在独立仓库）|
| 主题 | next-themes（`class` 策略，深/浅色）|
| 国际化 | next-intl（`messages/en.json`、`messages/zh.json`）|
| ORM | Prisma 7.8 + `@prisma/adapter-pg` 驱动适配器 + `pg` |
| 数据库 | PostgreSQL |
| 认证 | jose（签发/校验 JWT 会话 Cookie）+ 哈希 API Token + Agent API Key；管理员由 `ADMIN_EMAILS` 识别 |
| Agent/聊天 | Vercel AI SDK 7（`ai` + `@ai-sdk/react`）、assistant-ui、streamdown |
| MCP | `@modelcontextprotocol/sdk`，自研网关/桥接（`mcp-http-bridge` / `mcp-stdio-bridge`）|
| 渠道 | grammy（Telegram）、`@larksuiteoapi/node-sdk`（飞书）等 |
| 终端/桌面 | node-pty + xterm、noVNC（沙箱屏幕）、ws |
| 图标 | lucide-react、@primer/octicons-react |
| 测试 | Vitest 4（约 1800+ 用例：259 个 unit 文件、56 个 integration 文件，含少量 `.live.` 用例）、Playwright 裸库做 e2e |

主要环境变量（`.env.example`）：`DATABASE_URL`、`AUTH_SECRET`、`NEXT_PUBLIC_APP_URL`、`NEXT_PUBLIC_SUPPORT_EMAIL`、`ADMIN_EMAILS`、`CONNECTOR_WS_*`（Connector 接入）、`HERMES_DASHBOARD_*`、`TOOLPLANE_IMAGE/PLATFORM/UPDATE_*`（自更新）、`TOOLPLANE_MCP_STARTUP_*`（启动超时）。

---

## 3. 顶层架构

```
                          ┌──────────────────────────────────────────┐
   Browser                │            Next.js (App Router)           │
   ──────                 │                                          │
   Public visitor ──────► │  (site)  Static product marketing        │
   Signed-in user ──────► │  app/[workspace]  Console + real market  │
   Administrator ───────► │  admin/  Review, catalog, users, logs    │
   Agent / CLI ─────────► │  api/v1/* + api/openai/v1/*  JSON API    │
                          └───────┬──────────────┬───────────────────┘
                                  │              │
              ┌───────────────────▼──┐   ┌───────▼────────────────┐
              │ MCP Deployment 运行时  │   │ Agent Runtime           │
              │ builtin 子进程 /       │   │ Native 进程内 /          │
              │ Docker bridge 容器 /   │   │ Hermes 独立容器+持久卷    │
              │ 远程 MCP(HTTP/SSE)     │   │ Sandbox: Docker/Connector│
              └──────────────────────┘   └────────────────────────┘
```

**路由分组（route groups）：**

- `src/app/(site)/...` —— 独立公开产品站，只使用静态营销内容，**不读取真实市场或个人数据**。
- `src/app/app/(auth)/...` —— 登录/注册（URL `/app/login`、`/app/signup`）。
- `src/app/app/[workspace]/...` —— 工作区控制台，套 `DashboardChrome`；另有 `@modal` 拦截路由（如 settings/account 弹层）。
- `src/app/admin/...` —— 管理后台（独立 layout，要求管理员）。
- `src/app/api/v1/...`、`src/app/api/openai/v1/...` —— 无 UI 的 JSON 路由。

---

## 4. 目录结构

```
src/
├─ app/
│  ├─ (site)/            静态公开产品站（page/server/client/agents/
│  │                     categories/daily/leaderboards/news/search/sell/submit/
│  │                     privacy/terms/what-is-an-mcp-server）
│  ├─ app/
│  │  ├─ page.tsx                /app → 恢复/选择工作区（见 WORKSPACES.md）
│  │  ├─ (auth)/login, signup    /app/login, /app/signup
│  │  └─ [workspace]/   工作区控制台：mcp, skills, toolkits, market/{mcp,skills,
│  │                     agents,assistants,toolkits,installed,items,publish},
│  │                     agents, chat, knowledge, work,
│  │                     sandboxes, providers, observability, members, seller,
│  │                     settings{,/account,/tokens,/channels,/providers}, @modal
│  ├─ admin/            管理后台：agents, assistants, categories, logs,
│  │                     market, reviews, servers, settings, skills, users, workspaces
│  └─ api/
│     ├─ v1/            主 JSON API（见 §10）
│     └─ openai/v1/     OpenAI 兼容端点（models, chat/completions）
├─ components/
│  ├─ layout/  home/  cards/  server/  theme/  timezone/  marketing/  auth/
│  ├─ dashboard/        控制台全部组件（Chrome/Sidebar/Header/Tabs、
│  │                    MCP 检查器、ToolPlayground、Toolkits、Agent、聊天等）
│  ├─ admin/            管理后台组件
│  └─ ui/               本地基础组件（共享组件主要来自 @asharca/ui）
├─ lib/
│  ├─ auth/        session(jose), tokens, password, current-user, request-user,
│  │               safe-redirect, actions, token-format
│  ├─ process/     supervisor, spawn-spec(builtin/remote/bridge), mcp-gateway,
│  │               deployment-gateway, deployment-runtime-container,
│  │               deployment-config-volume, mcp-client, mcp-tool-catalog,
│  │               mcp-prompts, mcp-resources, mcp-result-redaction,
│  │               reconcile, sandbox, sandbox-mcp-client, git-source
│  ├─ agents/      Agent 域：run/native/sandbox-runtime/hermes/、channels/、
│  │               control-mcp, control-service, public-api/, market*, messaging,
│  │               conversation-*, model/provider catalog, platform runner 等
│  ├─ sandboxes/   沙箱：connector*(WS 接入/鉴权/broker)、runtime, images,
│  │               reconcile, file-list, actions/queries
│  ├─ chat/        聊天助手：service, branches, web-search
│  ├─ work/        Work 任务流：coordinator, sessions, state-machine, run-control
│  ├─ knowledge/   知识库
│  ├─ market/      统一市场：listings, artifact, skill/assistant manifest,
│  │               copy-updates, publisher-management, secret-scan
│  ├─ observability/ events(LogEvent), log, audit, http, queries, redaction,
│  │               maintenance, settings, system, plugin-telemetry
│  ├─ workspace/ toolkits/ skills/ seller/ admin/ system/ security/ http/
│  ├─ attachments/ plugin/ remote-mcp/ i18n/ marketing/ queries/
│  └─ db.ts        Prisma client + pg adapter
├─ i18n/            next-intl 配置
scripts/
│  ├─ mcp-server.mjs / mcp-tools.mjs     内置 MCP 演示 server 与工具
│  ├─ mcp-http-bridge.mjs / mcp-stdio-bridge.mjs / sandbox-mcp-server.mjs
│  ├─ native-runtime-session.mjs / dsh-runtime-driver.mjs   Agent runtime 驱动
│  ├─ assemble-runtime.mjs / start-server.cjs / bridge-env.mjs  打包与启动
│  └─ smoke-seed.ts / seed-real-mcp-skills.ts / import-*.ts / sync-tp-skills.ts
packages/
│  ├─ connector/    沙箱主机侧 Connector（`pnpm connector:dev`）
│  └─ ui/           （占位；共享 UI 已迁至 @asharca/ui 独立仓库）
runtime/migrator/   部署迁移器
prisma/
│  ├─ schema.prisma（68 个模型）
│  └─ migrations/   72 个迁移（0_init … 20260908000000_workspace_lifecycle）
tests/（unit/ integration/ stubs/）、e2e/
```

---

## 5. 数据模型（Prisma）

共 **68 个模型**，按域分组：

**目录内容**

- `Server` —— MCP 服务器（slug、配方/验证、部署来源）；`Client` —— MCP 客户端；`Skill` —— 技能（支持 GitHub/registry 来源、bundle）；`Category` —— 与 Server/Client/Skill/市场条目关联；`DailySnapshot` —— 每日排名快照。

**账户与工作区**

- `User`（含 locale、timeZone、status、角色）、`ApiToken`（prefix + tokenHash，可绑定 Toolkit 专用）、`PasswordResetToken`。
- `Workspace`（slug 唯一、owner、生命周期状态 active/deleting/delete_failed、模型偏好）、`Membership`、`WorkspaceInvitation`（一次性邀请，仅存哈希）、`WorkspaceAttachment`。

**MCP 运行时**

- `Deployment` —— 工作区里部署的某个 Server 或自定义来源（`source`/`installCfg`、`status`、`mcpToolExposure`/`mcpAllowedTools` 工具暴露控制、`publicInvocable` 公共调用闸门）。
- `DeploymentConfigFile` —— 部署配置文件（物化为托管卷挂载进容器）。
- `InstalledSkill`、`SkillInvocation`（插件遥测）、`Sandbox`、`SandboxSnapshot`。

**Toolkits**

- `Toolkit`（`visibility`、`enabled`）、`ToolkitServer`（↔ Deployment）、`ToolkitSkill`（↔ InstalledSkill）、`ToolkitInstallLink`（安装分享链接）。

**统一市场（Marketplace）**

- `MarketListing` —— 统一市场条目（MCP/Skill/Agent/Assistant，命名空间 + slug、分类、审核状态）；`MarketRelease` —— 不可变版本；`MarketInstall` —— 安装记录（含 requested release）。

**Agent 域**

- `Agent` + 组成关联：`AgentServer`（MCP）、`AgentSkill`、`AgentToolkit`、`AgentSubAgent`、`AgentKnowledgeBase`、`AgentComposerPrompt`、`AgentAttachment`、`AgentModelProvider`。
- `AgentRuntime`（kind：native/hermes，显式指定）、`AgentSandbox`（独占绑定）、`AgentRun`。
- 市场/发布：`AgentListing`、`AgentRelease`、`AgentInstall`。
- 消息平台：`AgentChannelConnection`（渠道凭据/绑定/沙箱范围）、`Conversation`、`Message`。
- 公共 API：`AgentEndpoint`、`AgentEndpointRevision`、`AgentEndpointRuntime`、`AgentApiClient`、`AgentApiKey`、`AgentApiUsageBucket`、`AgentApiMaintenanceLease`、`AgentPublicConversation`。

**聊天助手（Chat）**

- `ChatAssistant`（配置 + 市场来源）、`ChatAssistantMcpGrant`（MCP 授权）、`ChatThread`、`ChatTurn`、`ChatMessage`（分支支持）。

**Work 任务流**

- `WorkSession`（协调器驱动的后台执行）、`WorkApproval`（人工审批闸门）。

**知识库**

- `KnowledgeBase`、`KnowledgeDocument`、`KnowledgeChunk`。

**模型服务商**

- `ModelProvider`、`ProviderModel`（Hermes/Agent 可用模型目录）。

**可观测性与系统**

- `LogEvent`（可检索事件元数据 + trace/span）、`LogDetail`（受限诊断载荷，7 天保留）、`AuditEvent`（追加式审计）——详见 OBSERVABILITY.md。
- `SystemSetting`（管理设置）、`SyncEvent`（Toolkit 同步事件）。

---

## 6. 认证与会话

- **会话**：`lib/auth/session.ts` 用 `jose` 以 `AUTH_SECRET` 签发 JWT，存 HTTP-only Cookie。
- **密码**：`lib/auth/password.ts` 哈希与校验；忘记密码走一次性 `PasswordResetToken`（`account:reset-password` 脚本可人工重置）。
- **API Token**：user 级，`lib/auth/tokens.ts` 创建（一次性明文）/校验/吊销；可绑定 Toolkit 作专用 token。个人 token 管理在 `/app?view=account`（旧工作区内 tokens 页跳转过去）。
- **Agent API Key**：公共 Agent Endpoint 使用独立的 `AgentApiClient`/`AgentApiKey`，用量按 `AgentApiUsageBucket` 限额。
- **双通道鉴权**：`resolveRequestUser(req)` 先认 `Authorization: Bearer <token>`，否则回退会话 Cookie。
- **管理员**：`ADMIN_EMAILS` 环境变量识别，访问 `/admin/*` 与 `api/v1/admin/*`。

---

## 7. 公开产品站 `(site)`

公开站与后台市场严格解耦：页面只读取 `lib/marketing/content.ts` 中的独立中英文静态内容，不导入 `lib/db`、`lib/queries`、工作区或当前用户模块。

- **首页** `/` + 能力页 `/server`、`/client`、`/agents`。
- **目录式页面** `/categories`、`/search`、`/leaderboards`、`/daily` —— 营销化展示/固定重定向，不查询真实库。
- **静态/落地** `/news`、`/sell`、`/submit`（进入登录后控制台）、`/privacy`、`/terms`、`/what-is-an-mcp-server`。

`tests/unit/public-site-boundary.test.ts` 递归检查公开页面的依赖图，防止真实市场查询被重新引入前台。

---

## 8. 控制台 / Hub `app/[workspace]`

`layout.tsx` 解析工作区与登录态，渲染 `DashboardChrome`（侧栏分组 + 顶栏 + 移动抽屉）。侧栏组织可持久化（见 #122）。

### 8.1 MCP 服务器
- `/mcp` —— 已部署列表；`/market/mcp`、`/market/mcp/[serverSlug]` —— 登录后市场（仅管理员已验证且配方可解析的条目）。
- `/mcp/[deploymentId]` —— 检查器：Overview / Variables / **Tools**（`ToolPlayground` 实时 `tools/list` + 调用）/ Logs / **Terminal**（PTY 流）/ **Runtime files**（`DeploymentConfigFile` 编辑），支持 Connect/Restart/Stop/Rebuild 与 MCP JSON 配置编辑。

### 8.2 Skills / Toolkits
- `/skills`、`/market/skills`、`/skills/[installId]`（SKILL.md 预览/复制/下载）。
- `/toolkits`、`/toolkits/[slug]` —— 自由组装已部署 MCP 与已安装 Skill；导出 manifest、生成安装链接；同步机制见 TOOLKIT_SYNC.md。

### 8.3 Agents / Chat / Knowledge / Work / Sandboxes / Providers
- `/agents`、`/agents/[agentId]` —— Agent 管理与运行（runtime kind 显式选择：native 或 hermes 沙箱）；`/market/agents` 安装市场模板为独立副本；发布走 `/agents/[agentId]/publish` → 管理员 `/admin/agents` 审核。
- `/chat` —— 助手对话（`ChatAssistant` + 线程/分支/轮次，MCP 授权 `ChatAssistantMcpGrant`）。
- `/knowledge` —— 知识库（文档 → 分块）。
- `/work` —— Work 任务流会话与审批。
- `/sandboxes` —— 沙箱管理（Docker/Connector、快照、屏幕会话）。
- `/providers` —— 模型服务商与模型目录配置。
- `/market/assistants` —— 助手市场。

### 8.4 Observability
- `/observability` —— Usage / Audit log；统计卡、p95、按小时分布。数据来自统一 `LogEvent`（`gateway.request` 口径），Postgres 现场聚合。模型与口径详见 OBSERVABILITY.md。

### 8.5 Members / Settings / Seller
- `/members` —— 成员表、邀请（7 天一次性链接）、移除/退出（见 WORKSPACES.md）。
- `/settings` —— 名称/slug、默认模型、所有权转移、Danger zone 删除（`deleting` 状态机 + 清理进程/容器/卷）。
- `/settings/channels` —— 消息平台渠道（Telegram/飞书/QQ/微信/Discord/Slack，见 AGENT_MESSAGING_PLATFORMS.md）。
- `/settings/providers` —— 工作区级模型服务商凭据。
- `/settings/tokens` —— 保留入口；个人 API Token 实际在 `/app?view=account`。
- `/settings/account` —— 账户设置（含 `@modal` 拦截弹层）。
- `/seller` → `/seller/overview` —— 发布技能 + 我的上架。

---

## 9. 管理后台 `/admin`

- `/admin` —— 总览；`/admin/reviews`、`/admin/reviews/market/[id]` —— 市场条目/版本审核。
- `/admin/market`、`/admin/servers`、`/admin/skills`（含 `/skills/import`）、`/admin/agents`、`/admin/assistants`、`/admin/categories` —— 目录与统一市场管理（新建/编辑/精选/验证）。
- `/admin/users`、`/admin/workspaces` —— 账户与工作区治理。
- `/admin/logs`、`/admin/logs/[id]` —— 结构化事件检索与诊断详情（查看/导出本身也记审计）。
- `/admin/settings` —— 系统设置（`SystemSetting`：MCP 启动超时、远程 MCP 私网限制、诊断抓取窗口、自更新等）。

---

## 10. JSON API

主 API 在 `api/v1`（88 个路由），另有 OpenAI 兼容端点 `api/openai/v1/models`、`api/openai/v1/chat/completions`，机器可读定义见 `GET /api/v1/openapi.json`。按域分组：

| 域 | 代表路径 | 说明 |
|---|---|---|
| MCP 网关 | `POST /v1/mcp/[deploymentId]/rpc`、`GET .../health`、`.../runtime`、`.../files/upload`、`.../terminal/*` | 代理 JSON-RPC 到部署运行时；PTY 终端会话；记录可观测性 |
| Skills | `GET /v1/skills/[installId]/download`、`.../skill.md` | 工件下载 |
| 工作区/Toolkit | `GET /v1/workspaces/[slug]/manifest`、`.../toolkits/[toolkitSlug]/{manifest,install,mcp}`、`.../attachments`、`.../market/installs*` | manifest 导出、安装链接、Toolkit MCP 聚合 |
| Agent 控制 | `POST /v1/workspaces/[slug]/agents/mcp` | Agent Control MCP（仅个人 Bearer，见 AGENT_CONTROL_MCP.md）|
| Agent 运行 | `/v1/agents/[agentId]/{chat,messages,conversations*,composer,prompts,terminal,attachments,hermes/*}` | 控制台 Agent 会话/操作/命令 |
| Agent 公共 API | `/v1/agent-endpoints/[endpointId]/{responses*,conversations/*,client-tokens}` | 已发布 Endpoint 的对外执行（拓扑约束见 AGENT_PUBLIC_API.md）|
| Agent Runtime 回调 | `/v1/agent-runtime/{mcp,model}/...`、`/v1/agent-runtimes/[runtimeId]/{mcp,dashboard/*}` | 沙箱内 runtime 回调节点（签名 grant 鉴权）|
| 渠道 | `/v1/agent-channels/[connectionId]/events`、`/v1/workspaces/[slug]/agent-channels` | 消息平台事件入口 |
| 聊天助手 | `/v1/chat/assistants*`、`/v1/chat/threads/[threadId]/{turns,branches,composer,prompts}` | 助手/线程/轮次/分支 |
| Work | `/v1/work-sessions*`（events/input/cancel/resume/approvals/sandbox） | 任务流驱动与审批 |
| 知识库 | `/v1/knowledge*`（documents/search/agents） | 知识库 CRUD 与检索 |
| 市场 | `/v1/market/listings*`（download） | 统一市场读取 |
| 沙箱 | `/v1/workspaces/[slug]/sandboxes/{hermes-import,[sandboxId]/connector-status,screen/*}` | 沙箱状态、noVNC 屏幕帧 |
| Connector | `/v1/connectors/{bootstrap,package.tgz}` | 沙箱主机 Connector 接入 |
| 插件/同步 | `/v1/plugin/{baseline,sync-applied,sync-failure,skill-invocation}`、`/v1/skill-registries/tp-skills/webhook` | Toolkit 同步遥测与 registry webhook |
| 管理 | `/v1/admin/{logs/export,system/update,agent-releases/[releaseId]/manifest}` | 日志导出、自更新、发布清单 |
| 其他 | `/v1/health`、`/v1/attachments/[attachmentId]` | 健康检查、附件 |

**网关流程**（`/mcp/[id]/rpc`）：鉴权 → 校验 deployment 归属 → 定位运行时（builtin 子进程端口 / Docker 容器 / 远程 URL）→ 转发（带超时）→ `LogEvent` 落库（`gateway.request`，HTTP 200 但 RPC error 也算失败）。

---

## 11. MCP 运行时（`lib/process`）

- `spawn-spec.ts` —— 三类部署来源：`builtin`（内置演示 server）、`remote`（远程 MCP，streamable-http/sse，私网限制见管理设置）、`bridge`（Docker 容器内跑任意命令，经桥接暴露 JSON-RPC；git 来源先 clone）。
- `supervisor.ts` —— 子进程表存 `globalThis.__mcpSupervisor`（穿越 dev HMR）；启动解析、就绪超时、日志文件、脱敏值、看门狗。
- `deployment-runtime-container.ts` / `deployment-gateway.ts` —— Docker 容器命名/移除与容器内网关；`deployment-config-volume.ts` 把 `DeploymentConfigFile` 物化为托管卷。
- `mcp-client.ts` / `sandbox-mcp-client.ts` / `mcp-gateway.ts` —— 服务端 RPC 封装与工具聚合；`mcp-tool-catalog(-store).ts` 缓存工具清单；`mcp-prompts.ts`、`mcp-resources.ts`、`mcp-result-redaction.ts`。
- `reconcile.ts` —— DB 状态与实际进程/容器对账。
- `sandbox.ts` —— 网络/镜像/缓存标志；`git-source.ts` —— git 来源判定。

## 12. Agent 运行时

- **Native runtime** —— 进程内轻量 Agent（模型直连 + MCP/Skill 工具循环）。
- **Hermes runtime** —— 每个 Agent 独立 Docker 容器 + 独立持久卷 + 独立 API key；容器不能访问 Postgres，也没有用户级 token（详见 HERMES_AGENT_RUNTIME.md）。
- **沙箱** —— Docker 或经 Connector（`packages/connector`，WS 接入远程主机）提供 PTY 终端、文件、noVNC 屏幕；MCP tools 暴露给 Agent（详见 SANDBOXES.md）。
- Runtime 回调（模型/MCP）走 `/api/v1/agent-runtime/*`，使用带 trace 祖先的签名 grant。

---

## 13. 测试

- **单元/集成**（Vitest 4，约 1800+ 用例）：`tests/unit/*`（259 个文件）、`tests/integration/*`（56 个文件，含 db、admin、agent、market、runtime、workspace 等；`*.live.test.ts` 需要真实 Docker/网络）。
- `server-only` 用 `tests/stubs` 替身；公开站边界由 `public-site-boundary.test.ts` 守护。

---

## 14. 本地开发 & 运维注意

```bash
pnpm dev            # next dev (:3000)
pnpm db:migrate     # prisma migrate dev
pnpm db:generate    # prisma generate
pnpm db:seed        # 测试账号/工作区种子
pnpm test           # vitest run
pnpm connector:dev  # 本地 Connector（沙箱远程主机）
```

- **加 Prisma 模型后必须重启 dev server**：`prisma generate` 只更新磁盘 client，运行中的 Next 进程仍持旧 client。
- Prisma 7：用 `migrate diff --to-schema`（非 `--to-schema-datamodel`）；`prisma.config.ts` 自动加载 dotenv。
- 发布用 release-please（见 RELEASES.md）；版本以 `package.json` 与 CHANGELOG 为准（当前 0.29.0）。

---

## 15. 未完成项 / 已知限制

- 部分商业化流程（Seller 结算、Billing、Stripe、OAuth 登录）未接。
- Agent 公共 API 的执行目前只支持单 runtime-owning 进程/副本（process-local supervisor/队列，见 AGENT_PUBLIC_API.md）。
- 工作区删除清理的并发去重是单管理服务进程内的；多 worker 前需要数据库清理租约（见 WORKSPACES.md）。
- 日志存储是 best-effort 诊断（进程崩溃/过载可丢事件），非 durable 外部队列（见 OBSERVABILITY.md）。
