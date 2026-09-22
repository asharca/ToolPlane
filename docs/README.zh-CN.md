# ToolPlane 文档

> **English**: [README.md](./README.md)

从[项目介绍与快速开始](../README.md)入门，按下面的主题继续阅读。

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
| [沙箱与连接器](./SANDBOXES.zh-CN.md) · [English](./SANDBOXES.md) | Docker、设备连接、终端与屏幕 |
| [Agent Control MCP](./AGENT_CONTROL_MCP.zh-CN.md) · [English](./AGENT_CONTROL_MCP.md) | 从 MCP 客户端创建和调用 Agent |
| [公共 Agent API](./AGENT_PUBLIC_API.zh-CN.md) · [English](./AGENT_PUBLIC_API.md) | 发布 Endpoint、鉴权与限额 |
| [原生 A2A 1.0](./A2A_NATIVE.zh-CN.md) · [English](./A2A_NATIVE.md) | 标准任务、事件订阅、独立执行与发布授权 |
| [消息渠道](./AGENT_MESSAGING_PLATFORMS.zh-CN.md) · [English](./AGENT_MESSAGING_PLATFORMS.md) | Telegram、飞书、QQ、微信、Discord、Slack |
| [工作区管理](./WORKSPACES.md) · [English](./WORKSPACES.en.md) | 成员、邀请、所有权与删除 |

## 部署与维护

| 文档 | 内容 |
|---|---|
| [部署配置](./DEPLOYMENT.md) · [English](./DEPLOYMENT.en.md) | 镜像、端口、HTTPS、邮件与更新 |
| [升级与恢复](./RUNTIME_OPERATIONS.zh-CN.md) · [English](./RUNTIME_OPERATIONS.md) | 数据迁移、单所有者恢复与附件配额 |
| [日志与审计](./OBSERVABILITY.zh-CN.md) · [English](./OBSERVABILITY.md) | 日志模型、诊断抓取与保留策略 |
| [版本发布](./RELEASES.zh-CN.md) · [English](./RELEASES.md) | release-please 发布流程与 GitHub 配置 |
| [共享 UI](./UI_LIBRARY.zh-CN.md) · [English](./UI_LIBRARY.md) | `@asharca/ui` 更新与发布 |

## 维护约定

- 每个主题只维护一组中英文文档，顶部互链，并在两个索引登记；其他位置使用链接引用。
- 行为以代码为准；实现变化时，在同一 PR 更新两种语言。结构图和流程图优先使用 Mermaid。
- 新专题放在 `docs/` 根目录，使用 `TOPIC_NAME.md` 与 `.en.md` 或 `.zh-CN.md` 配对，开头说明用途与读者。
