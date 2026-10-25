# ToolPlane — 架构文档

> **English**: [ARCHITECTURE.en.md](./ARCHITECTURE.en.md)
>
> ToolPlane 是一个自托管 Agent 工具控制面，包含独立的公开产品站、带真实市场和 MCP/Agent/Sandbox 运行时的登录后控制台、管理后台，以及 JSON API。本文面向需要理解系统边界、定位实现和修改平台的开发者。

---

## 1. 项目概述

本项目是一个 MCP（Model Context Protocol）与 Agent 生态平台，分四大功能区：

1. **公开产品站** `(site)`：只展示产品优势与能力，不读取或镜像真实 MCP、Skill、Agent 市场数据。
2. **控制台 / Hub** `app/[workspace]`：浏览真实市场，部署 MCP，安装技能与智能体，将资源组装成 Toolkit，运行 Pi、Claude Code、DeepSeek Harness（DSH）或 Hermes Agent，使用聊天助手、知识库和 Work 任务流，查看可观测性。
3. **管理后台** `admin/`：审核市场条目，管理目录、用户、工作区、系统设置与日志审计。
4. **JSON API** `api/v1/*` + `api/openai/v1/*`：MCP 网关、技能下载、manifest 导出、Agent 公共 API、Agent Control MCP、渠道事件与管理接口。

MCP 部署可以是内置子进程、远程 MCP（Streamable HTTP / SSE）或 Docker bridge 容器。网关转发真实请求，而不是返回市场演示数据。

MCP 市场版本同时支持远程连接器与容器隔离的 stdio 服务。工作区配方无需预先存在目录条目，可通过现有审核流程发布；批准时执行真实握手并采集工具清单。程序配方必须固定 npm/PyPI 版本、完整 Git commit 或 Docker sha256 digest。JSON 配方保留 `command`（`npx`、`uvx`、`uv tool run` 或 `docker`）与 argv，不调用宿主 shell。版本只导出必填环境变量名，不包含已配置值，并拒绝携带凭据的 argv。安装/更新复用审核配方、Deployment 与 supervisor 生命周期：`setup_required` 表示配置缺失；安装记录的 `ready` 仅表示配置完整，不代表运行时已就绪。部署初始停止，需显式启动；握手与工具就绪由 supervisor 判断。MCP 安装/更新 API 请求格式不变。

“配方固定版本”不等于不可变运行时制品：该版本格式未按字节锁定 npm/PyPI 的传递依赖与平台包装镜像，不能将安装标记为可复现或内容寻址制品。可移植 Git 配方仅允许固定提交的 HTTPS GitHub 仓库，并保留既有沙箱网络限制；可执行项之后的保留包运行器选项一律拒绝，即使位于分隔符后。

已安装的市场 MCP 可通过显式 `targetReleaseId` 选择同一已发布条目中仍获批准的任意版本（含旧版本）；不传则选择最新版本。恢复使用所选版本的配方与审核工具快照，保留目标工作区环境变量值，不改变市场条目的最新版本，也不绕过本地修改或并发更新保护。

资源发现从选中的已批准版本投影 `sourceKind` 与结构化 `runtimeCompatibility`，不返回可执行快照内容。`listMarketListings` 和 `GET /api/v1/market/listings` 支持 `sourceKind` 与 `runtime=pi-sdk|mcp`；过滤发生于分页和计数之前，保留公开/工作区私有鉴权边界。Pi 的 `toolplane` 来源表示组装，MCP 区分远程 Streamable HTTP/SSE 与容器 stdio；未知兼容性保持 null，不作推断。

专题入口：

| 主题 | 文档 |
|---|---|
| Toolkit 同步 | [TOOLKIT_SYNC.md](./TOOLKIT_SYNC.md) |
| Docker / Connector 沙箱 | [SANDBOXES.zh-CN.md](./SANDBOXES.zh-CN.md) |
| Hermes 运行时 | [HERMES_AGENT_RUNTIME.md](./HERMES_AGENT_RUNTIME.md) |
| 消息渠道 | [AGENT_MESSAGING_PLATFORMS.zh-CN.md](./AGENT_MESSAGING_PLATFORMS.zh-CN.md) |
| Agent 公共 API | [AGENT_PUBLIC_API.zh-CN.md](./AGENT_PUBLIC_API.zh-CN.md) |
| Agent Control MCP | [AGENT_CONTROL_MCP.zh-CN.md](./AGENT_CONTROL_MCP.zh-CN.md) |
| 日志与审计 | [OBSERVABILITY.zh-CN.md](./OBSERVABILITY.zh-CN.md) |
| 工作区生命周期 | [WORKSPACES.md](./WORKSPACES.md) |
| UI 与发布 | [UI_LIBRARY.zh-CN.md](./UI_LIBRARY.zh-CN.md)、[RELEASES.zh-CN.md](./RELEASES.zh-CN.md) |

## 2. 技术栈

依赖版本和 Node 要求以 [`package.json`](../package.json) 与锁文件为准，避免在文档中维护另一份易过期的版本清单。

| 层 | 选型 |
|---|---|
| 应用 | Next.js App Router、React、TypeScript |
| 样式 | Tailwind CSS 与 `asharca/ui` 的原版 beUI Registry 源码 |
| 主题 / 国际化 | next-themes、next-intl（`messages/en.json`、`messages/zh.json`） |
| 数据 | PostgreSQL、Prisma、`@prisma/adapter-pg`、`pg` |
| 认证 | jose 签名的 JWT 会话、哈希 API Token、独立的 Agent API Key |
| Agent / 聊天 | `@earendil-works/pi-ai`、各沙箱 runtime；AI SDK UI 消息流、assistant-ui、streamdown |
| MCP | `@modelcontextprotocol/sdk` 与平台网关、HTTP/stdio 桥接 |
| 渠道 | grammy、`@larksuiteoapi/node-sdk` 等 Node 适配器 |
| 终端 / 桌面 | node-pty、xterm、noVNC、ws |
| 图标 | lucide-react、@primer/octicons-react |
| 测试 | Vitest；测试入口和环境以 `vitest.config.ts`、`tests/` 与 CI 为准 |

环境变量参见 [`.env.example`](../.env.example)：包括 `DATABASE_URL`、`AUTH_SECRET`、`NEXT_PUBLIC_APP_URL`、`ADMIN_EMAILS`、`CONNECTOR_WS_*`、`HERMES_DASHBOARD_*` 及启动、自更新配置。不要从一份示例环境文件推断所有路由采用相同鉴权方式。

## 3. 顶层架构

```text
Browser / CLI / Agent
  -> Next.js App Router
       |-- (site): 静态产品站
       |-- app/[workspace]: 工作区控制台与真实市场
       |-- admin: 管理后台
       `-- api/v1 + api/openai/v1: JSON / MCP API
             |-- MCP Deployment
             |    |-- builtin 子进程
             |    |-- Docker bridge
             |    `-- 远程 HTTP / SSE
             `-- Agent Runtime
                  |-- Pi / Claude Code / DSH: 专属沙箱
                  `-- Hermes: 专属容器与 /opt/data 持久卷

通用 Sandbox（Docker / User Connector）另外提供文件、PTY 与 MCP 工具。
```

路由分组不出现在 URL 中。`src/app/app/(auth)` 对应 `/app/login`、`/app/signup`；`src/app/app/[workspace]` 是带 `DashboardChrome` 的工作区界面；`src/app/admin` 有独立的管理员鉴权。API 不应继承 UI 的权限假设。

## 4. 目录结构

以下是定位实现的入口，不是每个文件的完整清单：

```text
src/
  app/
    (site)/                    静态公开产品站
    app/(auth)/                登录、注册
    app/page.tsx               账户入口、恢复或选择工作区
    app/[workspace]/           工作区控制台
    admin/                     管理后台
    api/v1/                    平台 API
    api/openai/v1/             OpenAI 兼容适配
  components/
    dashboard/                 控制台组件
    admin/                     后台组件
    ui/                        应用内基础组件
  lib/
    auth/                      会话、Token、账户与管理员策略
    process/                   MCP supervisor、桥接、工具清单与配置卷
    agents/                    runtime 选择、执行、Control MCP、公共 API
      hermes/                  Hermes 配置投影、代理、生命周期
    sandboxes/                 Docker / Connector、文件与运行时
    chat/                      助手、线程、分支
    work/                      协调器、会话、审批与运行控制
    knowledge/                 知识库
    market/                    市场条目、版本、安装与审核
    observability/             LogEvent、LogDetail、AuditEvent
    workspace/                 成员、邀请与删除流程
    toolkits/ skills/ plugin/   工具包、技能与客户端同步
    marketing/                 公开站静态内容
    db.ts                      Prisma + pg adapter
scripts/                       runtime 驱动、打包、启动、导入与种子脚本
packages/connector/            用户主机侧 Connector
runtime/migrator/              部署迁移器
prisma/schema.prisma           数据模型的权威定义
prisma/migrations/             数据库迁移历史
tests/                         单元、集成测试及替身
```

共享 UI 源码从 `https://asharca.github.io/ui/llms.txt` 的原版 beUI Registry 安装；ToolPlane 只保留本地领域适配器，不再消费旧的 `@asharca/ui` npm 包。模型、迁移、路由、测试数量应从当前源码或实际测试报告取得，不在此复制静态计数。

## 5. 数据模型（Prisma）

完整字段与关联以 [`prisma/schema.prisma`](../prisma/schema.prisma) 为准。主要领域包括：

| 领域 | 主要模型 |
|---|---|
| 目录 | `Server`、`Client`、`Skill`、`Category`、`DailySnapshot` |
| 账户与工作区 | `User`、`ApiToken`、`PasswordResetToken`、`Workspace`、`Membership`、`WorkspaceInvitation`、`WorkspaceAttachment` |
| MCP / Sandbox | `Deployment`、`DeploymentConfigFile`、`InstalledSkill`、`SkillInvocation`、`Sandbox`、`SandboxSnapshot` |
| Toolkit | `Toolkit`、`ToolkitServer`、`ToolkitSkill`、`ToolkitInstallLink` |
| 统一市场 | `MarketListing`、`MarketRelease`、`MarketInstall` |
| Agent 组成 | `Agent`、`AgentServer`、`AgentSkill`、`AgentToolkit`、`AgentSubAgent`、`AgentKnowledgeBase`、`AgentModelProvider`、`AgentComposerPrompt`、`AgentAttachment` |
| Agent 执行 | `AgentRuntime`、`AgentSandbox`、`AgentRun`、`Conversation`、`Message`、`AgentChannelConnection` |
| Agent 市场 | `AgentListing`、`AgentRelease`、`AgentInstall` |
| 公共 Endpoint | `AgentEndpoint`、`AgentEndpointRevision`、`AgentEndpointRuntime`、`AgentApiClient`、`AgentApiKey`、`AgentApiUsageBucket`、`AgentApiMaintenanceLease`、`AgentPublicConversation` |
| Chat / Work | `ChatAssistant`、`ChatAssistantMcpGrant`、`ChatThread`、`ChatTurn`、`ChatMessage`、`WorkSession`、`WorkApproval` |
| 知识 / 模型 | `KnowledgeBase`、`KnowledgeDocument`、`KnowledgeChunk`、`ModelProvider`、`ProviderModel` |
| 日志 / 系统 | `LogEvent`、`LogDetail`、`AuditEvent`、`SystemSetting`、`SyncEvent` |

`Deployment.mcpToolExposure` / `mcpAllowedTools` 决定工具暴露范围；`publicInvocable` 是公共调用的额外闸门。`ApiToken` 可以限定到 Toolkit；不要把它等同于账户级 Token。

运行时标识由 [`runtime-kind.ts`](../src/lib/agents/runtime-kind.ts) 定义为 `pi`、`claude-code`、`dsh`、`hermes`、`hermes-rpc`。文件名 `native.ts` 并不代表存在一个可选的 `native` runtime。

## 6. 认证与会话

- **会话与密码**：`lib/auth/session.ts` 使用 `jose` 和 `AUTH_SECRET` 签发 HTTP-only Cookie；`lib/auth/password.ts` 负责密码哈希。恢复密码使用一次性 `PasswordResetToken`，本地维护另有 `account:reset-password` 脚本。
- **个人 API Token**：创建时一次性返回明文，持久化哈希；个人管理入口为 `/app?view=account`。Toolkit 安装 Token 另有资源范围限制。
- **路由鉴权差异**：[`request-user.ts`](../src/lib/auth/request-user.ts) 中，`resolveRequestUser` 尝试 Bearer 后回退会话；`resolveAccountRequestUser` 拒绝 Toolkit Token；`resolveAgentControlRequestUser` 必须收到有效的账户级 Bearer，不能仅凭 Cookie 调用。
- **公共 Agent API**：使用独立的 `AgentApiClient` / `AgentApiKey` 体系及额度、作用域检查，不复用控制台会话。
- **管理员**：[`admin-policy.ts`](../src/lib/auth/admin-policy.ts) 的访问闸门检查 `user.role === 'admin'`，不是每次请求仅按邮箱放行。`ADMIN_EMAILS` 是管理员引导配置；账户停用状态也必须检查。

## 7. 公开产品站 `(site)`

公开站与真实市场解耦，只读取 `lib/marketing/content.ts` 中的中英文静态内容，不导入数据库、工作区或当前用户查询。

首页 `/` 与 `/server`、`/client`、`/agents` 展示产品能力；`/categories`、`/search`、`/leaderboards`、`/daily` 是营销展示或固定重定向；`/news`、`/sell`、`/submit`、`/privacy`、`/terms`、`/what-is-an-mcp-server` 是静态或落地入口。真实安装进入登录后控制台。

`tests/unit/public-site-boundary.test.ts` 检查依赖图，防止把真实市场查询重新引入公开站。

## 8. 控制台 / Hub `app/[workspace]`

工作区布局解析登录态与访问权限并渲染 `DashboardChrome`。以下路径均位于 `/app/[workspace]` 下：

| 入口 | 作用 |
|---|---|
| `/mcp`、`/market/mcp` | 已部署 MCP 与真实市场 |
| `/mcp/[deploymentId]` | 工具检查与调用、日志、Variables、PTY、运行时配置文件及生命周期操作 |
| `/skills`、`/market/skills`、`/skills/[installId]` | 技能安装、预览、复制与下载 |
| `/toolkits`、`/toolkits/[slug]` | 资源组合、manifest、安装链接和同步配置 |
| `/agents`、`/agents/[agentId]` | 显式选择 runtime，配置资源并运行 Agent |
| `/market/agents`、`/agents/[agentId]/publish` | 安装独立模板副本、发布并进入审核 |
| `/chat`、`/market/assistants` | 助手对话、线程与分支、助手市场 |
| `/knowledge`、`/work` | 知识库、任务流与审批 |
| `/sandboxes`、`/providers` | 沙箱、快照、屏幕；模型服务商和目录 |
| `/observability` | `LogEvent` 的 `gateway.request` 指标、分位数和小时聚合 |
| `/members`、`/settings` | 成员与邀请；名称、默认模型、所有权和删除 |
| `/settings/channels`、`/settings/providers` | 渠道与模型凭据 |
| `/settings/tokens`、`/settings/account` | 账户设置的旧工作区入口；个人 Token 在 `/app?view=account` |
| `/seller` | 发布与已上架资源 |

工作区重命名不改变 URL slug；`/app` 提供恢复、选择和无工作区的入口，不应被描述为无条件新建或进入默认工作区。详细规则见 [WORKSPACES.md](./WORKSPACES.md)。

## 9. 管理后台 `/admin`

`/admin` 展示概况，`/admin/reviews` 与 `/admin/reviews/market/[id]` 负责审核；`/admin/market`、`/admin/servers`、`/admin/skills`、`/admin/agents`、`/admin/assistants`、`/admin/categories` 维护目录和市场。`/admin/skills/import` 是技能导入入口。

`/admin/users` 与 `/admin/workspaces` 管理账户和工作区；`/admin/logs`、`/admin/logs/[id]` 检索事件和诊断详情，查看和导出也需审计。`/admin/settings` 管理启动超时、远程 MCP 私网限制、诊断抓取、自更新等系统设置。

## 10. JSON API

下面的路径省略共同前缀 `/api`。这是领域导航，不是完整 OpenAPI 清单；各路由的实际方法与鉴权以 `route.ts` 为准，公共 Agent API 的机器可读定义位于 `GET /api/v1/openapi.json`。

| 领域 | 代表路径 |
|---|---|
| MCP | `/v1/mcp/[deploymentId]/rpc`、`.../health`、`.../runtime`、`.../files/upload`、`.../terminal/*` |
| Skills | `/v1/skills/[installId]/download`、`.../skill.md` |
| Workspace / Toolkit | `/v1/workspaces/[slug]/manifest`、`.../toolkits/[toolkitSlug]/{manifest,install,mcp}`、`.../attachments`、`.../market/installs*` |
| Agent Control | `/v1/workspaces/[slug]/agents/mcp`（仅账户级 Bearer；创建仅接受 `pi` / `hermes`） |
| Agent 会话 | `/v1/agents/[agentId]/{chat,messages,conversations*,composer,prompts,terminal,attachments,hermes/*}` |
| 公共 Endpoint | `/v1/agent-endpoints/[endpointId]/{responses*,conversations/*,client-tokens}` |
| Runtime 回调 | `/v1/agent-runtime/{mcp,model}/...`、`/v1/agent-runtimes/[runtimeId]/{mcp,dashboard/*}` |
| 渠道 | `/v1/agent-channels/[connectionId]/events`、`/v1/workspaces/[slug]/agent-channels` |
| Chat | `/v1/chat/assistants*`、`/v1/chat/threads/[threadId]/{turns,branches,composer,prompts}` |
| Work / 知识库 | `/v1/work-sessions*`、`/v1/knowledge*` |
| 市场 | `/v1/market/listings*` |
| Sandbox / Connector | `/v1/workspaces/[slug]/sandboxes/...`、`/v1/connectors/{bootstrap,package.tgz}` |
| 插件 | `/v1/plugin/{baseline,sync-applied,sync-failure,skill-invocation}`、`/v1/skill-registries/tp-skills/webhook` |
| 管理 / 其他 | `/v1/admin/{logs/export,system/update,agent-releases/[releaseId]/manifest}`、`/v1/health`、`/v1/attachments/[attachmentId]` |

MCP 网关流程：鉴权 → 校验资源归属 → 定位实际进程、容器或远程地址 → 带超时转发 → 记录 `gateway.request`。HTTP 200 内的 JSON-RPC `error` 或 MCP `isError` 仍算业务失败。

### 10.1 Assistant 修订、模板与持久回合

Assistant 使用有界服务端会话执行器，不创建或调用 Agent，不加载 Skill、包扩展、shell 或本地项目目录。`ChatAssistantRevision` 是独立所有者的不可变配置；新线程固定 `assistantRevisionId`，旧线程不能改绑 Assistant 或历史修订。历史修订未解析的线程仍可读取消息和附件，但执行返回 409，须显式创建新线程。

- `POST /api/v1/chat/assistants` 返回 `201 {assistant}`；初始配置与修订 1 在同一事务发布。`PATCH /api/v1/chat/assistants/[id]` 必须带整数 `expectedRevision`，成功返回 `{assistant}`，版本竞争返回 409。`POST .../[id]/copy` 接受 `{name, expectedRevision, mcpGrants?}`，返回独立副本 `201 {assistant}`；副本默认没有工具授权。
- 创建/修改/复制的 MCP 输入为 `mcpGrants: [{deploymentId, allowedToolNames, expectedDefinitionChecksum?}]`，空列表不授权任何工具，不再接受 `deploymentIds`。新增授权、修改工具名单或重新批准连接时，必须提交发现阶段返回的 `expectedDefinitionChecksum`；服务端在连接操作锁内校验，不匹配返回 409 并要求重新发现和批准。完全未变的保留授权可以省略该字段，但必须保留原修订摘要，不能顺便刷新连接权限。修订另存服务端计算的 `definitionChecksum`；凭据值轮换不改权限，端点/传输/执行定义变化不能静默改变旧线程。每次调用取修订工具名单、实时 Assistant 授权与工作区策略的交集，在同一连接锁内重新检查并执行实际 HTTP/SSE 连接；stdio 网关、沙箱和内部 Agent/A2A 端点不可用。
- 编辑器通过 `GET /api/v1/chat/assistants/resources?workspaceId=...` 获取 `{deployments:[{id,name,status,tools:[{name,description}],available,definitionChecksum}]}`；只列出实际远程连接，工具目录应用实时工作区策略，不返回连接配置或凭据。
- Assistant 远程发现通过固定连接准备路径按需启动已停止的连接（包括凭据轮换后的重连），准备失败明确报错，不因旧进程状态静默删除工具。发现及调用前复查均读取完整分页目录，上限为 10 页、1,000 个工具、4 MB 累计响应和 15 秒；重复/无效游标、损坏或超限目录拒绝，不使用部分结果。平台自身执行网关（包括客户端登记 `/api/v1/pi-packages/installations/[id]/mcp`、沙箱及 Agent/Toolkit 网关）不能重新包装为 Assistant 远程来源。
- 模板根路径为 `/api/v1/chat/assistants/[id]/templates`。`GET` 返回 `{revisionId, revision, templates}`；`POST` 导入、`PATCH /[name]` 显式替换接受 `{expectedRevision, source}`；`POST /[name]/clone` 接受 `{expectedRevision, name}`。这些操作发布新的不可变修订，不更新其他 Assistant。`source` 是 `{kind:"markdown", path, markdown}` 或 `{kind:"release", releaseId, path}`，仅静态读取选定已授权版本的实际 Prompt 文件，不安装包。
- `POST /templates/preview` 和 `POST /templates/[name]/diff` 直接接受 `source`，返回 `{revision, before, after, changed, conflict}`；`GET /templates/[name]/export` 下载原始 Markdown，校验和在 `X-Toolplane-Prompt-Checksum`。导入检查文件/版本校验和、访问权、必需语义和命令冲突；需要 Agent 能力的模板不能用于 Assistant。
- 会话选择模板须调用 `GET /api/v1/chat/threads/[id]/templates`，返回该线程固定版本的 `{revisionId,revision,templates}`，而不是 Assistant 当前模板。`POST .../templates/[name]/preview` 接受 `{args:string|string[]}`，返回 `{text,metadata:{promptTemplate:{assistantId,revisionId,name,sourceReleaseId,path,checksum,args}},revisionId,revision}`；只进行静态服务端预览，不调用模型或工具，提交仍传模板选择，不信任客户端展开正文。
- `POST /api/v1/chat/threads/[id]/turns` 必须带 `idempotencyKey`，并接受现有 `messages`、`trigger`、`messageId`、`webSearchEnabled`、`reasoningEffort` 与可选 `template:{name,args:string|string[]}`。相同用户、相同键和相同请求获得同一 Run；不同内容重用键或同线程并发新请求返回 409。模板只在首次事务接纳时由服务端按线程固定修订展开；实际用户正文及 `data-prompt-template` 来源记录一起持久化，拒绝客户端伪造来源。重新生成是新 Run，不覆盖原回复。
- 新执行提交若运行时 owner 尚未就绪，返回 `503 {error:"runtime_not_ready"}`，并携带 `Retry-After: 5` 与 `Cache-Control: no-store`；不会接纳 Run、执行模型或工具。客户端应保留请求内容及幂等键，说明运行时恢复中，待就绪后显式重试；不可绕过 owner 或自动批准工具。
- 提交与订阅返回 AI SDK UI 消息流，响应头为 `X-Chat-Turn-Id`、`X-Chat-Run-Id`（同一 Run 身份）、`X-Chat-Cursor`、`X-Chat-Run-Status`。`GET .../turns/stream?runId=...&afterSequence=N` 仅重放 N 之后的持久事件，不启动执行；也可用整数 `Last-Event-ID`。每个持久事件后有临时 `data-chat-cursor`，内容 `{runId,sequence}`，供客户端按 Run + 序号去重。不存在 Run 返回 204，无效游标返回 400。
- `GET .../turns/stream?state=1&runId=...` 返回 `{runId,turnId,status,phase,cursor,generation,stopRequested,error,messages,confirmations}`。`status` 为 `pending/completed/failed/cancelled`；`phase` 区分 `queued/generating/tool_calling/awaiting_user/stopping/interrupted/execution_unknown` 及终态。先恢复快照、确认项和游标，再订阅增量；Run ID、游标不是授权凭据。
- `POST .../turns/confirmations` 接受 `{confirmationId,approved:boolean}`，仅原始用户在有效执行租约与实时访问权下可决定。确认与工具开始/结果均落库；离线不等于批准。`DELETE .../turns` 接受 `{turnId}`，返回 `{stopRequested,turnId}`，接受停止请求时为 202；这不是外部副作用已撤销的声明，实际状态从快照读取。
- 工具确认获批不保证最终派发：真正的远程 `tools/call` 之前，连接、工具目录及实时授权仍会复查。共享工具构造器明确拒绝实时 AI 曝光、或传输层证实尚未派发的拒绝，均记为已知 `failed` 并记录完成时间，不要求外部副作用对账；不能仅凭返回对象带 `error` 就推断尚未派发。一旦可能已派发，连接异常或取消仍记为 `execution_unknown`，不可自动重试或删除未解决账本。
- 删除线程或整个 Assistant 时，事务先取得与 Run 提交相同的线程行锁；删除 Assistant 还会锁定 Assistant 本身以串行化并发新线程创建。存在 `pending` Run 或 `executing/execution_unknown` 工具确认时返回 409，不物理级联删除消息、Run、事件或确认账本；请求停止并不等于副作用已结算，未知结果必须保留用于外部对账。

执行租约有代次围栏；事件、部分消息快照与终态先提交再发布。关闭网页只取消订阅，多标签页观察同一 Run。订阅、执行心跳、确认和工具调用持续检查账户/工作区授权。提交和订阅会对账过期租约：不能恢复的供应商流保留部分回复并标记中断，用户显式新 Run 重试；未知结果的外部调用标记 `execution_unknown`，不会自动重放。


## 11. MCP 运行时（`lib/process`）

`spawn-spec.ts` 解析 builtin、remote、bridge 等启动来源；bridge 在容器内运行命令，git 来源先准备源码。`supervisor.ts` 维护实际子进程状态、启动就绪、超时、脱敏值和日志；`reconcile.ts` 对账数据库状态与实际运行状态。

`deployment-runtime-container.ts`、`deployment-gateway.ts` 管理容器与网关；`deployment-config-volume.ts` 物化配置卷。`mcp-client.ts`、`sandbox-mcp-client.ts`、`mcp-gateway.ts` 负责调用和聚合；工具清单、prompts、resources 与结果脱敏有独立模块。

数据库显示 running 不等于进程必然存活。查询与操作应结合 supervisor 的有效状态，不能只信持久化状态。

## 12. Agent 运行时

| runtime 标识 | 当前执行形态 | 模型配置 |
|---|---|---|
| `pi` | 专属沙箱，Pi runtime | `providerId` + `model` |
| `claude-code` | 专属沙箱，Claude Code harness | `providerId` + `model` |
| `dsh` | 专属沙箱，DeepSeek Harness | `providerId` + `model` |
| `hermes` | 专属 Hermes 容器与 `/opt/data` 卷 | `AgentModelProvider` 多选，Hermes 管理具体模型分工 |

选择与能力判断见 [`runtime-kind.ts`](../src/lib/agents/runtime-kind.ts)，不可变修订准入见 [`revisions.ts`](../src/lib/agents/revisions.ts)，Pi 执行由 [`sandbox-turn.ts`](../src/lib/agents/sandbox-turn.ts) 承接。非 Pi 运行时的历史和文件保留只读；新执行必须创建新的 Pi Agent 并明确重新授权。

内部 `native.ts` 使用 `@earendil-works/pi-ai`，不是公开 `native` runtime，也不是以 AI SDK `streamText` 驱动的旧运行时。UI 消息流与模型执行引擎是不同层，不应混为一谈。

专属 runtime 的模型/MCP 回调使用平台的签名授权；Hermes 聚合 MCP 则使用绑定 runtime 的 Bearer Token。Hermes 不接收用户级 ToolPlane Token 或 Postgres 访问，但所选 provider 密钥确实写入它的私有配置卷，不能把“不公开密钥”误写成“容器没有 provider 密钥”。公共 Endpoint 的额外隔离和工具限制见 [AGENT_PUBLIC_API.zh-CN.md](./AGENT_PUBLIC_API.zh-CN.md)。

## 13. 测试

单元与集成测试在 `tests/unit/`、`tests/integration/`；`*.live.test.ts` 可能需要真实 Docker 或网络。`server-only` 通过测试替身处理，共享数据库的集成测试不得并发使用同一数据库。

文档修改优先检查链接、路径、命令与接口契约，不因纯文字改动启动服务。功能变更按影响范围运行单元、集成、类型、lint 与 build 检查。CI 的完整测试和 release-metadata 例外见 [UI_LIBRARY.zh-CN.md](./UI_LIBRARY.zh-CN.md)。

## 14. 本地开发与运维

```bash
pnpm dev            # Next.js 开发服务器
pnpm db:migrate     # prisma migrate dev；先确认目标数据库
pnpm db:generate    # 生成 Prisma client
pnpm db:seed        # 仅对确认的本地测试库执行
pnpm test           # vitest run
pnpm connector:dev  # 用户主机侧 Connector
```

增加 Prisma 模型并重新生成 client 后，需要重启持有旧 client 的开发服务器。Prisma 配置在 `prisma.config.ts`；迁移差异使用 `--to-schema` 而非旧的 `--to-schema-datamodel`。

版本以 `package.json` 与 CHANGELOG 为准，发布机制见 [RELEASES.zh-CN.md](./RELEASES.zh-CN.md)。不要把普通 PR 的 CI 成功当作已发布镜像，也不要把发布元数据检查当作重新执行了完整测试。

## 15. 已知边界

Agent 公共 API 只支持一个拥有 runtime 的应用进程；进程内 supervisor、执行队列和维护闸门并不因使用 Postgres 就变为多副本安全。工作区删除的去重和清理同样有单进程边界，扩展部署前需补充分布式租约与协调。

日志是有界、尽力而为的诊断存储，不是无损外部队列。诊断抓取可能保存经过脱敏的用户文本；脱敏不等于匿名化。公共 Agent API 与 Agent Control MCP 的载荷策略不同，分别以对应专题说明为准。

独立的 [Hermes RPC 沙箱运行时](./HERMES_RPC_RUNTIME.zh-CN.md)使用平台单模型与资源绑定，原托管 Hermes 保持不变。
