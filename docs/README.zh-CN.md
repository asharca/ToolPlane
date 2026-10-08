# ToolPlane 文档

> **English**: [README.md](./README.md)

从[项目介绍与快速开始](../README.md)入门，按下面的主题继续阅读。

## 文档网站

访问部署域名的 `/docs/zh` 阅读中文站，或 `/docs/en` 阅读英文站，无需登录；`/docs` 默认进入中文站。两种语言分别拥有独立首页、导航、侧栏和搜索，中文站按以下分类组织：

- **用户文档**（`/docs/zh/guides`）：安装、配置、集成与日常运维。
- **开发者文档**（`/docs/zh/developers`）：架构、运行时实现、贡献与发布维护。
- **API 文档**（`/docs-api`）：独立 Scalar 交互式参考，从 `/api/v1/openapi.json` 加载接口定义，不嵌入文档站。中文协议与接入说明仍可从开发者文档进入 `/docs/zh/api`。

网站采用 [Fumadocs](https://fumadocs.dev) 提供导航、响应式布局和全文搜索，正文复用安全的 Streamdown 渲染 Markdown、代码和 Mermaid。Fumadocs 在 `/docs/search` 生成静态搜索索引，内置搜索框在浏览器本地搜索并按当前语言与分类过滤。相对 Markdown 链接保留目标文档的语言，其他仓库文件链接指向 GitHub；共享链接解析位于 `src/lib/docs-links.ts`。

Markdown 原文件是唯一内容来源：直接修改 `docs/**/*.md`、仓库根目录的 `README.md` / `CHANGELOG.md` 或 `infra/firecrawl/README.md`，不要另建网站内容副本。`source.config.ts` 定义 Fumadocs MDX 内容集合，在构建时完成分类与语言识别：`.en.md` 为英文，`.zh-CN.md` 为中文，无语言后缀时，首个标题含汉字则为中文，否则为英文；标题应使用正文的语言。页面地址为 `/docs/{语言}/{分类}/{仓库相对主题路径}`，去掉文件名的语言后缀，同一主题的中英文共享主题路径。保留相对链接与中英文配对，新增主题时同步检查分类映射。Agent 指令、计划、隐藏文件、环境文件与源代码不作为文档发布。上述公开文档不要写入凭据或私有运维数据。

官方 Fumadocs MDX Next.js 插件按 Markdown（不是 MDX）编译白名单内的 `.md` 文件，将处理后的 Markdown 和搜索数据编入应用产物；不在请求时读取文件系统，也没有额外的内容复制管线。Docker 镜像和发布压缩包使用同一 standalone 产物，`server.js` 旁无需保留 Markdown 原文件。修改文档后需重新构建部署。

## 架构与运行时

| 文档 | 内容 |
|---|---|
| [系统架构](./ARCHITECTURE.md) · [English](./ARCHITECTURE.en.md) | 技术栈、模块与数据模型 |
| [Pi / Claude Code / DSH](./AGENT_RUNTIMES.zh-CN.md) · [English](./AGENT_RUNTIMES.md) | 执行链路、原生会话与安全边界 |
| [Hermes 运行时](./HERMES_AGENT_RUNTIME.md) · [English](./HERMES_AGENT_RUNTIME.en.md) | 配置、生命周期与凭据隔离 |
| [Hermes RPC](./HERMES_RPC_RUNTIME.zh-CN.md) · [English](./HERMES_RPC_RUNTIME.md) | 在所选 Docker 沙箱中运行原生 Hermes：配置、会话、边界与测试 |

## 使用与集成

| 文档 | 内容 |
|---|---|
| [Toolkit 同步](./TOOLKIT_SYNC.md) · [English](./TOOLKIT_SYNC.en.md) | 向 AI 客户端同步 MCP 与 Skill |
| [远程 MCP HTTP](./REMOTE_MCP_HTTP.zh-CN.md) · [English](./REMOTE_MCP_HTTP.md) | HTTP/HTTPS 端点、明文传输风险与保留的安全边界 |
| [沙箱与连接器](./SANDBOXES.zh-CN.md) · [English](./SANDBOXES.md) | Docker、设备连接、终端与屏幕 |
| [Agent Control MCP](./AGENT_CONTROL_MCP.zh-CN.md) · [English](./AGENT_CONTROL_MCP.md) | 从 MCP 客户端创建和调用 Agent |
| [公共 Agent API](./AGENT_PUBLIC_API.zh-CN.md) · [English](./AGENT_PUBLIC_API.md) | 发布 Endpoint、鉴权与限额 |
| [A2A 控制台接入](./A2A_CONSOLE.zh-CN.md) · [English](./A2A_CONSOLE.md) | 可视化启用、连接示例、凭据与本地任务调试 |
| [A2A MCP 适配](./A2A_MCP_BRIDGE.zh-CN.md) · [English](./A2A_MCP_BRIDGE.md) | 外部 MCP 客户端使用原生任务 |
| [A2A 资源限额](./A2A_RESOURCE_LIMITS.zh-CN.md) · [English](./A2A_RESOURCE_LIMITS.md) | 载荷存储、输出预留与迁移 |
| [远程 A2A Agent](./A2A_REMOTE_AGENTS.zh-CN.md) · [English](./A2A_REMOTE_AGENTS.md) | 注册、出站授权、远程委派与恢复 |
| [原生 A2A 1.0](./A2A_NATIVE.zh-CN.md) · [English](./A2A_NATIVE.md) | 标准任务、事件订阅、独立执行与发布授权 |
| [A2A 内部协作](./A2A_LOCAL_COLLABORATION.zh-CN.md) · [English](./A2A_LOCAL_COLLABORATION.md) | 本地身份、原生委派、父任务等待与恢复 |
| [消息渠道](./AGENT_MESSAGING_PLATFORMS.zh-CN.md) · [English](./AGENT_MESSAGING_PLATFORMS.md) | Telegram、飞书、QQ、微信、Discord、Slack |
| [工作区管理](./WORKSPACES.md) · [English](./WORKSPACES.en.md) | 成员、邀请、所有权与删除 |

## 部署与维护

| 文档 | 内容 |
|---|---|
| [部署配置](./DEPLOYMENT.md) · [English](./DEPLOYMENT.en.md) | 镜像、端口、HTTPS、邮件与更新 |
| [升级与恢复](./RUNTIME_OPERATIONS.zh-CN.md) · [English](./RUNTIME_OPERATIONS.md) | 数据迁移、单所有者恢复与附件配额 |
| [日志与审计](./OBSERVABILITY.zh-CN.md) · [English](./OBSERVABILITY.md) | 日志模型、诊断抓取与保留策略 |
| [版本发布](./RELEASES.zh-CN.md) · [English](./RELEASES.md) | release-please 发布流程与 GitHub 配置 |
| [共享 UI](./UI_LIBRARY.zh-CN.md) · [English](./UI_LIBRARY.md) | 原版 beUI Registry 源码接入 |

## 维护约定

- 每个主题只维护一组中英文文档，顶部互链，并在两个索引登记；其他位置使用链接引用。
- 行为以代码为准；实现变化时，在同一 PR 更新两种语言。结构图和流程图优先使用 Mermaid。
- 新专题放在 `docs/` 根目录，使用 `TOPIC_NAME.md` 与 `.en.md` 或 `.zh-CN.md` 配对，开头说明用途与读者。

- [统一入口与执行前审批](./A2A_INGRESS_APPROVALS.zh-CN.md)
