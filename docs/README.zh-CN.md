# ToolPlane 文档索引

> **English**: [README.md](./README.md)
>
> 本目录是 ToolPlane 的唯一权威文档源。新读者建议顺序：**根目录 [README](../README.md) → [ARCHITECTURE.md](./ARCHITECTURE.md) → 按任务查下表专题**。
> 参考 [Diátaxis](https://diataxis.fr/) 的思路，文档按读者任务分类：**概念与架构**（理解系统）、**使用与集成**（完成具体任务）、**运维与发布**（运行系统）。

---

## 概念与架构（Explanation）

| 文档 | 内容 |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) ([English](./ARCHITECTURE.en.md)) | **总入口**：技术栈、顶层架构、目录结构、Prisma 领域模型、控制台/后台/JSON API 全貌 |
| [AGENT_RUNTIMES.zh-CN.md](./AGENT_RUNTIMES.zh-CN.md) ([English](./AGENT_RUNTIMES.md)) | Pi、Claude Code、DSH 实现：执行链路、模型/MCP 代理、原生会话、Skill、事件、安全边界与排障 |
| [HERMES_AGENT_RUNTIME.md](./HERMES_AGENT_RUNTIME.md) ([English](./HERMES_AGENT_RUNTIME.en.md)) | Hermes 运行时：配置投影、生命周期、网络与凭据边界；完整运行时清单见架构文档 |
| [SANDBOXES.zh-CN.md](./SANDBOXES.zh-CN.md) ([English](./SANDBOXES.md)) | Agent 沙箱形态：Docker / Connector runtime、MCP tools 暴露、PTY 终端 |
| [OBSERVABILITY.zh-CN.md](./OBSERVABILITY.zh-CN.md)) | 日志/审计模型：`LogEvent` / `LogDetail` / `AuditEvent` 的口径、采集与保留策略 |
| [WORKSPACES.md](./WORKSPACES.md) ([English](./WORKSPACES.en.md)) | 工作区生命周期：成员、邀请、所有权转移、删除状态机 |

## 使用与集成（How-to）

| 文档 | 内容 |
|---|---|
| [TOOLKIT_SYNC.md](./TOOLKIT_SYNC.md) ([English](./TOOLKIT_SYNC.en.md)) | Toolkit 同步到 Claude Code / Codex / opencode / Hermes：token、本地文件布局 |
| [AGENT_CONTROL_MCP.zh-CN.md](./AGENT_CONTROL_MCP.zh-CN.md) ([English](./AGENT_CONTROL_MCP.md)) | 工作区级 Agent Control MCP：用 MCP 客户端创建和调用 Agent |
| [AGENT_PUBLIC_API.zh-CN.md](./AGENT_PUBLIC_API.zh-CN.md) ([English](./AGENT_PUBLIC_API.md)) | 已发布 Agent Endpoint 的公共 API：鉴权、限额、部署拓扑约束 |
| [AGENT_MESSAGING_PLATFORMS.zh-CN.md](./AGENT_MESSAGING_PLATFORMS.zh-CN.md) ([English](./AGENT_MESSAGING_PLATFORMS.md)) | 消息渠道接入：Telegram / 飞书 / QQ / 微信 / Discord / Slack |

## 运维与发布（Operations）

| 文档 | 内容 |
|---|---|
| [RELEASES.zh-CN.md](./RELEASES.zh-CN.md) ([English](./RELEASES.md)) | release-please 发布流程与 GitHub 配置 |
| [UI_LIBRARY.zh-CN.md](./UI_LIBRARY.zh-CN.md) ([English](./UI_LIBRARY.md)) | 共享 UI 包 `@asharca/ui` 的更新与发版工作流 |
| [OBSERVABILITY.zh-CN.md](./OBSERVABILITY.zh-CN.md) ([English](./OBSERVABILITY.md)) | （同上）诊断抓取窗口、日志导出、保留期管理 |
| [WORKSPACES.md](./WORKSPACES.md) ([English](./WORKSPACES.en.md)) | （同上）工作区删除迁移的部署注意事项 |

---

## 文档约定

- **单一事实源**：每个主题在每种语言中只维护一份文档，其余地方用链接引用，不复制段落。
- **代码为准**：描述与代码冲突时以代码为准，并修正文档；改代码导致行为变化时同 PR 更新对应文档。
- **新文档**：专题文档放本目录根部，文件名用全大写下划线（`TOPIC_NAME.md`），开头一段话说明「这是什么、给谁看」，并在本索引登记。
- **语言**：每份专题文档都是中英双语——中文原文 `NAME.md` + 英文译文 `NAME.en.md`，或英文原文 + 中文译文 `NAME.zh-CN.md`，顶部互链，索引同时链接两个版本。新文档必须同时提供两种语言，修改应在同一 PR 中同步两份。

## 运行时部署

[运行时运维](./RUNTIME_OPERATIONS.zh-CN.md)（[English](./RUNTIME_OPERATIONS.md)）说明架构迁移、单所有者恢复、安装凭据和附件配额。
