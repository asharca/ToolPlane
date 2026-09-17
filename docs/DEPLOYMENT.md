# 部署配置

> **English**: [DEPLOYMENT.en.md](./DEPLOYMENT.en.md)

本文面向部署和维护 ToolPlane 的运维人员，说明镜像、网络、邮件、启动超时与更新配置。启动命令见[快速开始](../README.md#快速开始)，数据迁移和故障接管见[升级与恢复](./RUNTIME_OPERATIONS.zh-CN.md)。

## 运行环境

使用 VM、VPS 或容器宿主机，保持**单个持续运行的应用进程**。MCP 与 Sandbox 由进程内监督器管理，不适合 Serverless；数据库锁不代表支持多实例同时执行。

[Docker Compose](../docker-compose.yml) 运行 Postgres、Docker Socket Proxy 和 GHCR 预构建应用镜像。应用通过受限代理访问 Docker，代理必须仅在 Compose 内部网络可见，不能公开 Docker API。

| 配置 | 用途 |
|---|---|
| `AUTH_SECRET` | 必须替换为随机密钥，可用 `openssl rand -base64 32` 生成 |
| `NEXT_PUBLIC_APP_URL` | 生成安装命令、回调与连接配置的唯一对外地址 |
| `TOOLPLANE_IMAGE` | 应用镜像；生产环境可固定到具体发布版本或提交标签 |
| `TOOLPLANE_PLATFORM` | 已发布服务端镜像的平台，默认 `linux/amd64` |

完整配置说明见 [`.env.example`](../.env.example)。不要提交实例密钥、生产环境文件或备份。

## 端口与反向代理

Compose 默认发布以下端口；绑定地址由对应的 `*_HOST_BIND` 控制：

| 服务 | 默认宿主机端口 | 端口变量 | 绑定地址变量 |
|---|---|---|---|
| 应用 HTTP | `10030` | `APP_HOST_PORT` | `APP_HOST_BIND` |
| Connector WebSocket Broker | `9321` | `CONNECTOR_WS_HOST_PORT` | `CONNECTOR_WS_HOST_BIND` |
| Hermes Dashboard Broker | `9332` | `HERMES_DASHBOARD_HOST_PORT` | `HERMES_DASHBOARD_HOST_BIND` |

Compose 中未设置绑定变量时使用 `0.0.0.0`；示例环境文件会将部分 Broker 绑定到回环地址，部署时须核对实际生效配置。反向代理与应用同机时优先绑定 `127.0.0.1`；位于另一台机器时使用私网地址，并仅允许代理主机访问。外部 Broker 地址可通过 `CONNECTOR_WS_PUBLIC_URL` 和 `HERMES_DASHBOARD_PUBLIC_URL` 配置，具体路由见[沙箱与连接器](./SANDBOXES.zh-CN.md)及 [Hermes 运行时](./HERMES_AGENT_RUNTIME.md)。

公网服务应使用 HTTPS，在反向代理终止 TLS，并转发正确的主机名和协议。`NEXT_PUBLIC_APP_URL` 必须与实际入口一致。根域与 `www` 同时存在时，为两者配置有效证书并统一重定向；不使用的记录应删除。

代理应替换而不是追加客户端提供的 `X-Forwarded-For` / `X-Real-IP`，并对登录、注册和密码恢复的 Server Action 设置边缘限流。

## 邮件与账户恢复

通过 `SMTP_URL` 和 `SMTP_FROM` 配置密码恢复邮件。未配置出站邮件时，管理员可在已配置正确数据库连接的应用环境中执行：

```bash
pnpm account:reset-password -- user@example.com
```

该命令签发随机临时密码，并使现有浏览器会话失效。妥善交付临时密码，不要写入公开日志。

`TOOLPLANE_PASSWORD_RESET_GLOBAL_LIMIT` 控制十分钟内的实例级密码恢复请求上限，默认 `200`。这是进程内保护，不能替代反向代理限流。

## MCP 启动超时

首次从 npm、PyPI 或 GitHub 安装依赖可能较慢。Compose 提供两个启动看门狗参数，单位均为毫秒：

| 配置 | 默认值 | 含义 |
|---|---|---|
| `TOOLPLANE_MCP_STARTUP_IDLE_TIMEOUT_MS` | `300000` | 最长无进展时间（5 分钟） |
| `TOOLPLANE_MCP_STARTUP_MAX_TIMEOUT_MS` | `900000` | 启动总时限（15 分钟），不得小于空闲时限 |

修改 `.env` 后需重新创建或部署应用。也可在 **Admin → Settings** 保存覆盖值，于下一次 MCP 启动或重启时生效；管理员设置优先，重置后恢复环境变量配置。

## 更新与发布

升级前备份 Postgres 和托管运行时卷，核对[升级顺序](./RUNTIME_OPERATIONS.zh-CN.md#升级顺序)。不要让新旧应用同时操作同一运行域。

管理员可从工作区侧边栏的更新入口检查 GitHub Release。更新器下载 `TOOLPLANE_UPDATE_ARTIFACT`（默认 `toolplane-runtime-linux-amd64.tar.gz`），核验 `.sha256` 资产，替换 `/app` 中的运行时文件并退出。Docker 或 Coolify 通过 `restart: unless-stopped` 重启同一容器。

更新请求在下载前返回 `202 Accepted`，浏览器随后查询任务状态和新进程标识。不要仅凭 HTTP 成功或容器存活判断升级完成；运行时接流前还需确认 `/api/v1/readiness` 返回 HTTP 200。

发布 `v*` 标签会发布 GHCR 镜像和自更新运行时资产。镜像发布、release-please 和仓库设置见[版本发布](./RELEASES.zh-CN.md)。

## 开发与 CI

本地开发叠加 `docker-compose.dev.yml`，将 Postgres 暴露在 `127.0.0.1:5433`；宿主机上的开发应用使用 `http://localhost:3000`，不要沿用 Compose 的 `10030` 公网地址。

`pnpm db:seed` 仅用于本地演示：创建演示账户、停止状态的调试 MCP、Skill 和 Toolkit，不拉取外部 Skill 或启动 MCP。消息渠道使用原生 Node 传输，本地调试不需要 Hermes Checkout 或 Python 渠道运行器；接入方式见[消息渠道](./AGENT_MESSAGING_PLATFORMS.zh-CN.md)。

完整 CI 在 PR 或手动触发时运行，合并到 `main` 后不重复运行。建议保护 `main`，要求 PR 保持最新，并要求 `validate`、`connector (ubuntu-latest)`、`connector (macos-latest)`、`connector (windows-latest)` 检查，管理员也不例外。共享 UI 使用 `asharca/ui` 发布的 `@asharca/ui` npm 包，流程见[共享 UI](./UI_LIBRARY.zh-CN.md)。
