# ToolPlane

> 统一管理 MCP 和 Skill，同步到 AI 客户端，或在沙箱中直接运行 Agent。

ToolPlane 是一个自托管的 AI 工具与 Agent 平台，以工作区组织工具、技能、模型和运行环境。实例凭据、工作区数据与托管运行时由部署者管理。

[中文文档](docs/README.zh-CN.md) · [English docs](docs/README.md) · [部署指南](docs/DEPLOYMENT.md)

## 核心能力

- **MCP 管理**：从目录或自定义配置部署服务，支持 npm、PyPI、GitHub 和 Docker 来源。
- **Toolkit 同步**：组合 MCP 与 Skill，同步到 Claude Code、Codex、OpenCode 和 Hermes 客户端。
- **Agent 执行**：在沙箱中运行 Pi、Claude Code、DSH、Hermes RPC 或托管 Hermes，接入工作区工具和技能。
- **沙箱与设备**：管理 Docker 沙箱，通过 Connector 连接自己的电脑，或通过 ADB 桥接 Android。
- **观测与集成**：查看调用、延迟和错误，通过 MCP、API 或消息渠道接入。

## 工作方式

```mermaid
flowchart TB
  MCP["MCP 服务"] --> Toolkit["Toolkit · 可复用工具包"]
  Skills["Skill · 技能与文件"] --> Toolkit
  Toolkit -->|同步| Clients["AI 客户端<br/>Claude Code · Codex · OpenCode · Hermes"]
  Toolkit -->|挂载| Agent["工作区 Agent<br/>Pi · CC · DSH · Hermes RPC · Hermes"]
  Agent --> Sandbox["Docker 沙箱"]
```

Toolkit 既可以供外部客户端使用，也可以挂载到平台 Agent。各运行时的模型兼容性、附件和公开 API 支持范围见[运行时文档](docs/AGENT_RUNTIMES.zh-CN.md)与 [Hermes 文档](docs/HERMES_AGENT_RUNTIME.md)。

## 快速开始

获取项目并准备配置；已有 `.env` 时请保留原配置：

```bash
git clone https://github.com/asharca/ToolPlane.git
cd ToolPlane
test -f .env || cp .env.example .env
```

启动前，将 `.env` 中的 `AUTH_SECRET` 替换为随机密钥，可用 `openssl rand -base64 32` 生成。

### Docker 部署

需要 Docker Compose。将 `NEXT_PUBLIC_APP_URL` 设为实际访问地址；本机体验可使用默认的 `http://localhost:10030`。

```bash
docker compose pull app
docker compose up -d
```

应用默认端口为 `10030`。公网部署前，请配置 HTTPS、端口访问控制及备份，详见[部署指南](docs/DEPLOYMENT.md)。

### 本地开发

需要 Node.js 22+、pnpm 和 Docker。在 `.env` 中使用以下本地地址：

```dotenv
DATABASE_URL="postgresql://mcp:mcp@localhost:5433/toolplane?schema=public"
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm dev
```

访问 `http://localhost:3000`。可选执行 `pnpm db:seed` 创建本地演示账户 `smoke@example.com` / `password123`；不要在生产数据库运行演示种子。

## 使用入口

在工作区中部署 MCP、导入 Skill 并组成 Toolkit，然后选择同步到客户端或创建 Agent。外部 AI 客户端可从 **Agents → Connect AI** 获取 Agent Control MCP 配置。

设备连接请使用沙箱页面生成的 Connector 命令；支持范围、系统要求及屏幕访问方式见[沙箱与连接器](docs/SANDBOXES.zh-CN.md)。连接器以本地用户权限运行，不等同于隔离容器。

## 开发命令

| 命令 | 用途 |
|---|---|
| `pnpm dev` | 启动开发服务 |
| `pnpm lint` / `pnpm test` | 代码检查与测试 |
| `pnpm build` | 生产构建 |
| `pnpm db:migrate` / `pnpm db:studio` | 开发数据库迁移与查看 |
| `pnpm connector:dev` | 调试设备连接器 |

## 文档

| 主题 | 入口 |
|---|---|
| 架构与运行时 | [系统架构](docs/ARCHITECTURE.md) · [Pi / Claude Code / DSH](docs/AGENT_RUNTIMES.zh-CN.md) · [Hermes RPC](docs/HERMES_RPC_RUNTIME.zh-CN.md) · [Hermes](docs/HERMES_AGENT_RUNTIME.md) |
| 工具与客户端 | [Toolkit 同步](docs/TOOLKIT_SYNC.md) · [沙箱与连接器](docs/SANDBOXES.zh-CN.md) |
| 对外集成 | [Agent Control MCP](docs/AGENT_CONTROL_MCP.zh-CN.md) · [公共 API](docs/AGENT_PUBLIC_API.zh-CN.md) · [消息渠道](docs/AGENT_MESSAGING_PLATFORMS.zh-CN.md) |
| 部署与维护 | [部署配置](docs/DEPLOYMENT.md) · [升级与恢复](docs/RUNTIME_OPERATIONS.zh-CN.md) · [日志与审计](docs/OBSERVABILITY.zh-CN.md) |

平台内部任务委派与授权见 [Agent 间协作](docs/AGENT_COLLABORATION.zh-CN.md)。

完整目录见[文档索引](docs/README.zh-CN.md)。ToolPlane 需要单个持续运行的应用进程，不适合 Serverless，也不要让多个实例同时操作同一运行域。
