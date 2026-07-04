# ToolPlane — 架构文档

> ToolPlane 是一个自托管 Agent 工具控制面，包含一个**公开目录站**、一个**带真实 MCP/Agent/Sandbox 运行时的控制台**，以及一套 **JSON API**。

---

## 1. 项目概述

本项目是一个 MCP（Model Context Protocol）生态平台，分三大功能区：

1. **公开目录站** `(site)` —— 浏览/搜索 MCP 服务器、客户端、技能（Skills），含分类、排行榜、每日榜。
2. **控制台 / Hub** `app/[workspace]` —— 登录后的工作区：部署 MCP 服务器（**真实子进程**）、安装技能、把它们**自由组装**成 Toolkit、通过网关调用工具、查看可观测性。
3. **JSON API** `api/v1/*` —— MCP JSON-RPC 网关、技能下载、Toolkit/工作区 manifest 导出。

核心特点：控制台里的 MCP 不是“假数据”——每次部署都会 `spawn` 一个真实的 Node 子进程跑 JSON-RPC server，网关把请求代理过去并记录可观测性。

Toolkit 同步到 Claude Code、Codex、opencode 的安装脚本、MCP tools 聚合、skills baseline、token 轮换和本地文件布局见 [`docs/TOOLKIT_SYNC.md`](./TOOLKIT_SYNC.md)。

Agent 沙箱的 Docker/Connector runtime、MCP tools 暴露方式和 skill script 执行路径见 [`docs/SANDBOXES.md`](./SANDBOXES.md)。

---

## 2. 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Next.js 16.2.9（App Router + Turbopack）、React 19.2 |
| 语言 | TypeScript 5 |
| 样式 | Tailwind CSS v4（`@tailwindcss/postcss`，`@theme inline`，方角 `--radius:0`，控制台用圆角设计系统）|
| 主题 | next-themes（`class` 策略，深/浅色）|
| ORM | Prisma 7.8 + `@prisma/adapter-pg` 驱动适配器 + `pg` |
| 数据库 | PostgreSQL |
| 认证 | jose（签发/校验 JWT 会话 Cookie）+ 哈希 API Token |
| 图标 | lucide-react |
| 采集 | Playwright + cheerio（`scraper/`）|
| 测试 | Vitest 4（单元/集成，53 用例）、Playwright 裸库做 e2e |

环境变量（`.env.example`）：`DATABASE_URL`、`AUTH_SECRET`（会话签名）、`NEXT_PUBLIC_APP_URL`。

---

## 3. 顶层架构

```
                          ┌─────────────────────────────────────────┐
   Browser                │            Next.js (App Router)          │
   ──────                  │                                         │
   Public visitor ──────► │  (site)  Public directory (RSC)          │
                          │     └─ queries/*  ──► Prisma ──► Postgres│
   Signed-in user ──────► │  app/[workspace]  Console (session)      │
                          │     └─ workspace/* toolkits/* actions    │
   Agent / CLI ─────────► │  api/v1/*  JSON API (Bearer/session)     │
                          │     └─ /mcp/[id]/rpc  Gateway proxy      │
                          └──────────────┬──────────────────────────┘
                                         │ HTTP 127.0.0.1:<port>
                                         ▼
                          ┌─────────────────────────────────────────┐
                          │  MCP child process (one per Deployment) │
                          │  scripts/mcp-server.mjs (JSON-RPC 2.0)   │
                          │  Managed by lib/process/supervisor.ts    │
                          └─────────────────────────────────────────┘
```

**路由分组（route groups）：**

- `src/app/(site)/...` —— 公开站，套 `(site)/layout.tsx`（Header/Footer/公告条），**不含任何个人数据/认证**；只通过 `/app/login`、`/app/signup` 链接进入 app。
- `src/app/app/(auth)/...` —— 登录/注册（URL `/app/login`、`/app/signup`），套居中的 `(auth)/layout.tsx`。
- `src/app/app/[workspace]/...` —— 工作区控制台，套 `DashboardChrome`（侧栏 + 顶栏 + 移动抽屉）；Settings 内含 **API Tokens**（`/app/[workspace]/settings/tokens`）。
- `src/app/api/v1/...` —— 无 UI 的 JSON 路由。

---

## 4. 目录结构

```
src/
├─ app/
│  ├─ (site)/            Public directory
│  │  ├─ page.tsx                Home (HomeView)
│  │  ├─ server/ ... /[slug]     MCP server list/pages/detail
│  │  ├─ client/ ... /[slug]     MCP client list/detail
│  │  ├─ tools/skills/ ...       Skill list/detail/leaderboard
│  │  ├─ categories/ ... /[slug] Category pages
│  │  ├─ leaderboards, daily, daily/skills, search
│  │  ├─ hub, sell, submit       Public hub/seller/submit pages
│  │  └─ privacy, terms, news, what-is-an-mcp-server  Static pages
│  ├─ app/               Console namespace (URL /app)
│  │  ├─ page.tsx                /app -> default workspace -> /app/<slug>/mcp
│  │  ├─ (auth)/login, signup    /app/login, /app/signup (centered auth layout)
│  │  └─ [workspace]/   Workspace console (see sec. 8; settings/tokens = API tokens)
│  │  ├─ layout.tsx              DashboardChrome
│  │  ├─ mcp, mcp/new, mcp/[deploymentId]
│  │  ├─ skills, skills/new, skills/[installId]
│  │  ├─ toolkits, toolkits/[slug]
│  │  ├─ observability, members, settings
│  │  ├─ seller -> seller/overview, agents
│  └─ api/v1/            JSON API (see sec. 9)
├─ components/
│  ├─ layout/   Header, Footer, AnnouncementBar, Logo
│  ├─ home/     HomeView, RotatingHeadline, FaqSection
│  ├─ cards/    EntityCard, ServerCard, ClientCard, SkillCard
│  ├─ dashboard/  Chrome, Sidebar, Header(+Controls), TabBar,
│  │             ConnectDialog, ReadyToConnectBanner, ToolPlayground,
│  │             ToolkitsBrowser, FeatureGateCard, WorkspaceSwitcher,
│  │             StatusBadge, CopyButton, BrowseGrid, DashboardLogo
│  ├─ server/   ServerList     (dashboard/ also has TokenManager, SettingsTabs)
│  └─ theme/    ThemeProvider, ThemeToggle
├─ lib/
│  ├─ auth/        session(jose), tokens, password, current-user,
│  │               request-user, safe-redirect, actions, token-format
│  ├─ process/     supervisor(child processes), mcp-client(RPC client)
│  ├─ observability/ log (record + aggregate, including p95)
│  ├─ queries/     servers, clients, skills, categories, home, search
│  ├─ workspace/   queries, actions
│  ├─ toolkits/    queries, actions
│  ├─ hub/, seller/, skills/(artifact)
│  └─ db.ts        Prisma client + pg adapter
scripts/
│  ├─ mcp-server.mjs   JSON-RPC HTTP server for one MCP
│  ├─ mcp-tools.mjs    5 built-in tools + RPC handler
│  └─ smoke-seed.ts    Test account/workspace seed
scraper/              Playwright+cheerio crawler
prisma/
│  ├─ schema.prisma
│  └─ migrations/  0_init, 20260624122620_add_toolkits
tests/, e2e/
```

---

## 5. 数据模型（Prisma）

共 16 个模型。目录侧与 Hub 侧两块。

**目录（采集得到的内容）**

- `Server` —— MCP 服务器（slug、name、author、stars、isOfficial/Featured、installCfg、readme）。多对多 `Category`、多对多 `User`（Hub 收藏）、一对多 `Deployment`。
- `Client` —— MCP 客户端。
- `Skill` —— 技能（score、多对多 `Category`、一对多 `InstalledSkill`）。
- `Category` —— 与 Server/Client/Skill 多对多。
- `DailySnapshot` —— 每日排名快照（entityType/entityId/date/rank/score）。
- `ScrapeCheckpoint` —— 采集断点续传。

**账户与 Hub（运行时状态）**

- `User` —— 邮箱 + `passwordHash`，拥有 `ApiToken[]`、`Workspace[]`、`Membership[]`、Hub 收藏 `Server[]`。
- `ApiToken` —— 程序化访问令牌，存 `prefix` + 唯一 `tokenHash`（不存明文）。
- `Workspace` —— 工作区（slug 唯一、owner），含 `deployments`、`installedSkills`、`requestLogs`、`toolkits`、`members`。
- `Membership` —— 用户 ↔ 工作区（role）。
- `Deployment` —— 工作区里部署的某个 Server（status，`@@unique([workspaceId, serverId])`）。对应一个真实子进程。
- `InstalledSkill` —— 工作区安装的某个 Skill。
- `RequestLog` —— 网关请求日志（method/path/statusCode/durationMs），可观测性来源。
- `Toolkit` —— 命名工具包（name、slug、`visibility` private|public、`enabled`，`@@unique([workspaceId, slug])`）。
- `ToolkitServer` —— Toolkit ↔ Deployment 关联（自由组装）。
- `ToolkitSkill` —— Toolkit ↔ InstalledSkill 关联。

> Relationship: `Workspace 1-* Deployment / InstalledSkill / Toolkit`; `Toolkit *-* Deployment` via `ToolkitServer`, and `*-* InstalledSkill` via `ToolkitSkill`.

---

## 6. 认证与会话

- **会话**：`lib/auth/session.ts` 用 `jose` 以 `AUTH_SECRET` 签发 JWT，存 HTTP-only Cookie。`getCurrentUser()`（`current-user.ts`）解析会话取当前用户。
- **密码**：`lib/auth/password.ts` 做哈希与校验。
- **注册/登录/登出**：`lib/auth/actions.ts`（Server Actions）。登录支持安全回跳 `?next=`（`safe-redirect.ts` 防开放重定向）。
- **API Token**：`lib/auth/tokens.ts` 创建（返回一次性明文）、按 `tokenHash` 校验、吊销；在 `/app/[workspace]/settings/tokens` 用 `TokenManager` 管理（工作区 Settings 的 API Tokens 标签页）。
- **双通道鉴权**：`lib/auth/request-user.ts` 的 `resolveRequestUser(req)` 先认 `Authorization: Bearer <token>`，否则回退到会话 Cookie——所以 API 既能被 CLI/Agent 用 Token 调，也能被浏览器同源调用。

---

## 7. 公开目录站 `(site)`

Server Components 直接走 `lib/queries/*` 查 Prisma 渲染。

- **首页** `/` —— `HomeView`：两段式 mono 大标题 + `RotatingHeadline`、分区网格（Top MCP / Top Skills，带“What are Agent Skills?”徽章）、`FaqSection`。
- **MCP 服务器** —— `/server`（列表，`ListingHero` + 分类 chips + 分页）、`/server/page/[page]`、`/server/[slug]`（两栏详情：面包屑、作者/星标、About、Deploy & connect 面板（网关用法）、Open dashboard CTA、相关 MCP/Skills）。
- **MCP 客户端** —— `/client`、`/client/[slug]`。
- **技能** —— `/tools/skills`、`/tools/skills/[slug]`、`/tools/skills/leaderboard`。
- **分类** —— `/categories`（关键词→lucide 图标映射）、`/categories/[slug]`。
- **榜单** —— `/leaderboards`（Top 100，排名角标）、`/daily`、`/daily/skills`、`/search`（跨 Server/Client/Skill 搜索）。
- **静态/落地** —— `/hub`（**纯公开营销落地页**；"Get started"→`/app/signup`、"Sign in"→`/app/login`）、`/sell`、`/submit`、`/privacy`、`/terms`、`/news`、`/what-is-an-mcp-server`。
- **认证已移出公开站** —— 登录注册在 `/app/login`、`/app/signup`；API Token 在工作区 `/app/[workspace]/settings/tokens`。**Hub 功能已移除**（原 `/app/account`、`/api/v1/hub` 删除）。公开站不含任何个人数据/认证页。

---

## 8. 控制台 / Hub `app/[workspace]`

`layout.tsx` 解析工作区与登录态，渲染 `DashboardChrome`：左侧 `DashboardSidebar`（MANAGE / MONITOR / WORKSPACE 分组 + Sell Skills + Support/Feedback + `WorkspaceSwitcher`），顶栏 `DashboardHeader`（面包屑或标题 + `DashboardHeaderControls`：⌘K 命令面板、主题切换、Help）。移动端为汉堡抽屉。

### 8.1 MCP 服务器
- `/mcp` —— 已部署列表（状态、创建时间、Inspect/Start/Stop/Restart/Remove）。`displayStatus()` 会用进程表对账 DB 状态，避免“DB 说 running 但进程已死”。
- `/mcp/new` —— 从目录浏览并部署（`deployServerAction`）。
- `/mcp/[deploymentId]` —— **检查器**：面包屑、标题 + Running + `Refreshed` 时间、动作 Connect/Restart/Stop/Rebuild，标签页 **Overview / Variables / Tools / Logs**（用 `?tab=` 切换）。
  - Overview：`ReadyToConnectBanner`（内置 `ConnectDialog`）+ Identity 卡（Endpoint + 复制、Created）+ Observability 入口。
  - Tools：`ToolPlayground`，对运行中的进程实时 `tools/list` 并可调用工具。
  - Connect：`ConnectDialog` 弹「Install server」客户端选择器（Claude Code/Desktop、Cursor、VS Code、Codex、Windsurf、Cline、Gemini、Connection URL），按真实网关地址生成可复制安装片段。

### 8.2 Skills
- `/skills` —— 列表；空态是「Create. Refine. Sync.」三步引导卡（STEP 01/02/03）。
- `/skills/new` —— 浏览安装（`installSkillAction`）。
- `/skills/[installId]` —— 技能检查器：「How to use」+ `SKILL.md` 预览/复制/下载。

### 8.3 Toolkits（自由组装）
- `/toolkits` —— `ToolkitsBrowser`：副标题、**New Toolkit**（内联命名创建）、搜索过滤、表格（名称 + Private/Public 徽章 | Status | Tools | Created）。
- `/toolkits/[slug]` —— 详情，标签页 **Overview / MCPs / Skills**：
  - MCPs/Skills 标签即「组装区」：上半「In this toolkit」（× Remove），下半「Available」（+ Add）——把工作区里**已部署的 MCP / 已安装的 Skill** 自由增删进该工具包。
  - 默认工具包 `My Toolkit`（slug `me`）首次访问惰性创建，并用工作区现有项预填。
  - 每个工具包导出独立 manifest（见 §9）。

后端动作（`lib/toolkits/actions.ts`）：create / delete / setVisibility / add·removeServer / add·removeSkill，全部做工作区授权校验。

### 8.4 Observability
- `/observability` —— 标签页 **Usage / Audit log**；4 张统计卡（Total Requests·24h、Error Rate、Avg Latency、**P95 Latency**）、Requests-per-hour 柱状图（requests/errors 图例）、Audit log 表。数据来自 `RequestLog`，`getObservability()` 现场聚合（含 p95）。**真实数据**，非 mock。

### 8.5 Members / Settings / Seller / Agents
- `/members` —— 「Invite your team」Team-plan 引导卡（对齐ToolPlane的付费门）+ 下方真实成员表。
- `/settings` —— 子导航（General / API Tokens / Integrations / Billing）+ Organization name & URL slug 表单（`renameWorkspaceAction`）+ 时区显示 + Danger zone「Delete organization」（`deleteWorkspaceAction`，删前 `killMany` 关停子进程）。
- `/seller` → 重定向 `/seller/overview` —— Marketplace 引导卡 + 真实发布技能表单（`submitSkillAction`）+ 我的上架列表。
- `/agents` —— Coming soon 占位。

### 8.6 认证 `/app/(auth)` + API Token `settings/tokens`

- **认证** —— `app/(auth)/login`、`app/(auth)/signup`（URL `/app/login`、`/app/signup`），套居中的 `(auth)/layout.tsx`；成功后默认跳 `/app`（→ `getOrCreateDefaultWorkspace` → 工作区控制台），即"进入 app 界面"。
- **API Token** —— 在工作区 Settings 内：`/app/[workspace]/settings/tokens`，`DashboardChrome` + `SettingsTabs`（General / API Tokens）+ 重设计的 `TokenManager`（`components/dashboard/`）。**同页不跳转**。Token 是 **user 级**，在任意工作区 Settings 下都是同一份。

> **Hub 已移除**：原 `/app/account` 账户区、`/app/account/hub` 个人 Hub、`GET /api/v1/hub`、`HubConnect`、公开 server 页的 Add-to-Hub 全部删除——它只是收藏夹+清单接口，和 Toolkit 重叠。`User.hubServers` 关系暂留在 Prisma schema（未迁移），已无代码使用。公开站 `(site)/hub` 仍是营销落地页。

---

## 9. JSON API `api/v1`

| 方法 & 路径 | 鉴权 | 作用 |
|---|---|---|
| `POST /api/v1/mcp/[deploymentId]/rpc` | Bearer 或 会话 | **MCP 网关**：把 JSON-RPC 2.0 请求代理到该部署的子进程，记录可观测性 |
| `GET /api/v1/mcp/[deploymentId]/health` | — | 部署健康检查 |
| `GET /api/v1/skills/[installId]/download` | Bearer 或 会话 | 下载 `SKILL.md` 工件 |
| `GET /api/v1/workspaces/[slug]/manifest` | Bearer 或 会话 | 导出整个工作区的 toolkit manifest（全部部署+技能）|
| `GET /api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/manifest` | Bearer 或 会话 | 导出**单个** toolkit 的 manifest（仅该包选中项）|

**网关流程**（`/mcp/[id]/rpc`）：`resolveRequestUser` 鉴权 → 校验该 deployment 属于用户工作区 → 用 `livePort()` 找到子进程端口 → `fetch http://127.0.0.1:<port>/`（3s 超时）→ 透传响应 → `logRequest` 落库（含 `#method` 便于审计）。进程未运行返回 503，上游不可达返回 502。

---

## 10. MCP 运行时（进程监督）

**`lib/process/supervisor.ts`** —— 每个 `Deployment` 对应一个子进程，进程表存在 `globalThis.__mcpSupervisor`（穿越 dev HMR，不被模块重载清空）。

- `startProcess(id, name)` —— `spawn` `scripts/mcp-server.mjs`（`MCP_PORT=0` 让 OS 选端口、`MCP_NAME`）；解析 stdout 的 `LISTENING <port>` → 状态置 `running`、记端口；3s 就绪超时。
- `stopProcess` / `restartProcess` / `killProcess`（SIGKILL）/ `killMany`（删工作区时批量清理，避免孤儿进程）。
- `liveStatus(id)` / `livePort(id)` —— 给页面与网关读实时状态/端口。
- 状态变化经 `persist()` 同步回 `Deployment.status`。

**`scripts/mcp-server.mjs`** —— 单个 MCP 的最小 HTTP 服务，跑 JSON-RPC 2.0（`initialize` / `tools/list` / `tools/call` / `ping`，protocolVersion `2025-06-18`）；启动打印 `LISTENING <port>`；提供 `GET /health`；带 ppid 看门狗（父进程没了自杀，防孤儿）。
**`scripts/mcp-tools.mjs`** —— 纯逻辑：内置 5 个工具 `echo / add / current_time / random_number / uppercase` + `createRpcHandler()`。

**`lib/process/mcp-client.ts`** —— 服务端调用封装：`mcpRpc(deploymentId, method, params)`、`listMcpTools(deploymentId)`（页面用它拉工具清单/工具数）。

---

## 11. 数据采集 `scraper/`

Playwright + cheerio 用于导入公开 MCP/Skill 目录数据，落库到 `Server/Client/Skill/Category`：`browser.ts`（受控浏览器）、`enumerate.ts`、`fetch-detail.ts`、`parse.ts`、`rate-limit.ts`、`scrape-servers/clients/skills/server-details/home-flags.ts`。`ScrapeCheckpoint` 支持断点续传。采集器仅用于导入公开元数据，不复制受版权保护的页面资产。

---

## 12. 测试

- **单元/集成**（Vitest 4，53 用例）：`tests/unit/*`（auth、命令面板、卡片、mcp-tools、安全回跳、SKILL.md 工件、工具台、工作区切换、限流、解析…）、`tests/integration/*`（db、home、ingest、queries）。`server-only` 用 `tests/stubs` 替身。
- **e2e**（`e2e/dashboard.e2e.mjs`，裸 `playwright` 库）：signup → deploy → running → stop → start → install → download 全链路。`npm run test:e2e`（需 dev server 在跑）。

---

## 13. 本地开发 & 运维注意

```bash
npm run dev          # next dev (:3000)
npm run db:migrate   # prisma migrate dev
npm run db:generate  # prisma generate
npm test             # vitest run
npm run test:e2e     # playwright e2e
```

- **加 Prisma 模型后必须重启 dev server**：`prisma generate` 只更新磁盘上的 client，正在运行的 Next 进程仍持旧 client（会 `db.xxx is undefined` → 500）。
- Prisma 7：用 `migrate diff --to-schema`（非 `--to-schema-datamodel`）；`prisma.config.ts` 自动加载 dotenv。
- 测试账号：`smoke@example.com` / `password123`（工作区 `smoke`、`staging`）。

---

## 14. 未完成项

- Observability/Members/Seller 的部分商业化流程仍是引导卡或占位。
- Settings 的 Integrations/Billing 子页未建（占位）；时区为只读展示。
- Toolkit 详情页的「可见性切换 / 删除」后端 action 已具备，UI 按钮尚未接上。
- 品牌字体暂用 Geist/Inter 系列，后续可替换为正式品牌字体。
- OAuth / Stripe 未接（需真实外部凭据）。
- `/daily` 为「今日榜单」而非ToolPlane的多日快照归档（缺每日采集管道）。
