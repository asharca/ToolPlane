# Agent 沙箱

> **English**: [SANDBOXES.md](./SANDBOXES.md)

Agent 沙箱为 Agent 提供一个行为类似小型操作环境的工作区。在本项目中，沙箱以 MCP tools
的形式暴露给 Agent，并以 PTY 终端流的形式暴露给浏览器控制台。应用不会把任意的服务器
宿主机目录挂载为沙箱。

## 运行时形态

```txt
Agent
|-- MCP deployments
|-- Skills
|-- Toolkits
`-- Sandboxes
    `-- Sandbox deployment
        `-- scripts/sandbox-mcp-server.mjs
            |-- sandbox_info
            |-- shell_exec
            |-- list_dir
            |-- read_file
            |-- write_file
            `-- terminal session stream
```

## 模式

### Docker Linux

Docker 模式启动一个持久容器和卷：

```txt
Sandbox row
`-- Deployment source=sandbox
    `-- sandbox-mcp-server
        `-- docker container
            `-- /workspace volume
```

默认镜像：

```txt
mcr.microsoft.com/devcontainers/javascript-node:24-bookworm
```

容器非特权运行，移除 Linux capabilities，带 pids/cpu/memory 限制，可使用专用的
`mcp-sandbox` 网络或 `none`。

#### 工作区数据生命周期

以下详细生命周期适用于 Docker Linux 沙箱。每个 Docker 沙箱拥有一个挂载在 `/workspace`
的 named volume：

- 创建沙箱会创建其专属工作区卷。
- 克隆会创建新沙箱，并把源沙箱当前的工作区卷复制到克隆的新卷中。克隆继承源镜像、网络
  和沙箱配置，但不继承源沙箱的快照记录。
- 创建快照会把当前工作区卷复制到一个独立的 named volume，并记录在源沙箱上。
- 恢复就绪快照会替换当前工作区卷的内容。恢复前数据的临时副本用于恢复复制失败时的自动
  回滚，随后删除。如果恢复和自动回滚都失败，ToolPlane 会让沙箱保持停止，并把该副本保留
  为就绪的恢复快照，而不是从部分恢复的数据启动。
- 删除快照先移除其 named volume，再删除数据库记录。Docker 清理失败会被报告，记录保留
  可重试。

克隆、创建快照和恢复会先静默受影响的沙箱：受管的 MCP 进程被终止、Docker 容器被停止后
才复制任何卷。操作完成后（包括回滚路径），原本运行的沙箱会重新启动；原本停止的保持
停止。正在 provisioning 的沙箱必须先完成 provisioning 才能开始这些操作。克隆复制成功
后，新克隆作为独立沙箱启动。删除快照只移除独立的快照卷，不会暂停沙箱。

卷复制在带命名和标签的辅助容器中进行。克隆在辅助容器退出且清理被确认前保持不可运行的
`copying` 状态；服务器启动时会移除残留辅助容器，并把中断的克隆改为 `copy_failed`，此时
只能删除。恢复的恢复记录在备份复制开始前创建，并在活动卷被替换前标记为就绪。随后部署
保持 `restoring`，直到活动卷确认为完好。如果辅助容器清理暂时无法确认，沙箱保持
`restore_cleanup_required`；清理后，中断的恢复变为 `restore_failed`，此时只能恢复就绪
的恢复快照或删除。临时恢复记录在其卷被移除前先进入 `deleting`，避免崩溃留下指向已丢失
卷的可恢复记录。

生命周期操作按沙箱串行化。工作区删除先关闭进程内的工作区闸门并排空进行中的操作，再取
得用于严格外部清理的清单。如 README 部署要求所述，ToolPlane 必须以单个常驻 Node 进程
运行；多个控制面副本无法安全共享同一个本地 Docker runtime。

删除 Docker 沙箱会停止其进程，严格移除每一个快照卷，然后移除其容器和主工作区卷，最后
删除数据库记录。工作区删除遵循同样的「先快照、后运行时」严格清理顺序。外部清理开始前，
部署进入不可运行的 `deleting` 状态。如果 Docker 或数据库清理失败，该状态被保留用于幂
等重试，而不是暴露一个空的重建工作区卷。

只有挂载在 `/workspace` 的 named volume 会被复制或快照。容器可写层、其他挂载中的数据
和外部服务都不包含。例如，写到 `/workspace` 之外的文件、只装进运行中容器可写层的包，
不会被复制到克隆，也不会被快照恢复捕获或回滚。

用户 Connector 沙箱不支持克隆或快照操作。Connector 数据留在用户机器上，ToolPlane 不复
制也不删除它。

Hermes 运行时沙箱在其受管运行时面板中提供重命名、环境变量、快照、恢复和删除快照的控
制。Hermes 快照复制其持久 `/opt/data` 卷，其中包含工作区以及 Hermes 会话、记忆、附件
和原生配置。它不包含镜像层变更，也不包含 `Conversation`、`AgentAttachment` 等 ToolPlane
数据库记录；它是卷快照，不是完整的逻辑 Agent 检查点。Hermes 不支持直接克隆沙箱，因为一
个 runtime 永久绑定一个 Agent；需要第二个 Hermes runtime 时请使用 Agent 克隆流程。

Hermes 快照和恢复操作会获取 runtime 维护闸门，使聊天和附件写入不会与卷复制竞争。恢复
后，ToolPlane 会重新投影当前 Agent 持有的 provider、MCP、skill 和环境配置，再重启此前
正在运行的 runtime。这样即使恢复的卷来自较旧的 runtime 状态，控制面配置也能保持一致。

### 用户 Connector

Connector 模式让用户暴露自己机器上的一个目录，无需开 SSH、配置密钥，也无需让平台主动
连接任意用户主机。Linux、macOS、Windows PowerShell 和 Windows 命令提示符都使用同一行
命令：

```text
npx -y --no-audit --package "http://localhost:3002/api/v1/connectors/package.tgz?v=0.1.13" connector connect --server "http://localhost:3002" --token "mcpcon_..." --root "~/toolplane-sandbox" --screen-vnc "auto"
```

Connector 要求 Node.js 20+、能访问 ToolPlane 的 HTTP 和 WebSocket 端点、能访问 npm
registry。托管的 tarball 包含 CLI 包元数据；`npx` 会从配置的 npm registry 下载其 `ws`
和 `node-pty` 依赖。Windows 支持面向 Windows 10 1809 或更新版本及 Windows 11 的
x64/arm64，`node-pty` 在其上使用 ConPTY。如果 PowerShell 策略阻止 `npx.ps1`，可在命令
提示符中原样运行该命令。配置好的本地根目录由 bootstrap 返回；`--root <path>` 仍是面向
开发的可选手动覆盖，并会作为控制台显示的实际根目录回报。

屏幕支持基于能力探测。桌面 connector 仅在带 `--screen-vnc auto` 时探测
`127.0.0.1:5900`；显式 `--screen-vnc 127.0.0.1:<port>` 可选择另一个本地 VNC 服务。找到
后，沙箱页会增加由 noVNC 支撑的 Screen 标签页。它以只读打开，由用户显式启用控制。平台
创建一次性、60 秒有效的 viewer ticket 并转发 RFB 字节流；平台无法选择 connector 的 VNC
目标。macOS 上使用 **VNC viewers may control screen with password** 下配置的密码，而不
是 Mac 账户密码。

Android 通过一台旁边装有 `adb` 的电脑使用同一个 connector：

```text
npx -y --no-audit --package "http://localhost:3002/api/v1/connectors/package.tgz?v=0.1.13" connector connect --server "http://localhost:3002" --token "mcpcon_..." --root "/sdcard/ToolPlane" --android "auto"
```

手机可使用 USB 调试或 Android 11+ 无线调试。`auto` 要求恰好一台已授权设备，否则传入
其受限的 ADB 序列号。Shell、PTY 和文件操作通过 ADB 在 Android shell 用户下执行。屏幕显
示使用 `adb exec-out screencap -p`，为只读。

沙箱页在创建 connector 沙箱或用户点击 **Generate command** 时生成 `mcpcon_...` token。
该命令启动本地 connector agent。agent 调用平台 bootstrap 端点，发现 WebSocket broker，
然后保持一条已认证的 WebSocket 会话。

```txt
User machine
`-- connector package tarball from /api/v1/connectors/package.tgz
    |-- native shell (PowerShell on Windows, POSIX shell on macOS/Linux)
    |-- local filesystem root
    |-- structured process execution
    |-- local PTY (ConPTY on Windows)
    |-- optional loopback VNC source
    `-- optional Android ADB device
        |
        | WebSocket
        v
Platform connector broker
`-- sandbox-mcp-server
    |-- shell_exec
    |-- process_exec
    |-- list_dir
    |-- read_file
    |-- write_file
    |-- terminal stream
    `-- authenticated screen relay
```

关键性质：

- 平台从不主动打开到用户机器的连接。
- connector token 通过 HTTP 和 WebSocket 的 `Authorization: Bearer` 头发送，绝不放进 URL。
- 文件操作被客户端约束在 bootstrap 配置的根目录之下。
- 交互式终端是 `node-pty` 在用户机器上创建的真实 PTY，因此 shell 补全和正常终端行为得
  以保留。
- connector 在 v2 握手中上报其平台、架构、shell 家族、Node 版本和能力。`sandbox_info`
  暴露这些值，Agent 据此在 Windows 上使用 PowerShell 语法、在其他平台使用 POSIX 语法。
- `shell_exec` 和 PTY 有意以启动 connector 的本地用户权限运行。它们不是 OS 安全边界，
  能访问超出配置文件工具根目录的内容。不可信负载请使用专用的低权限账户。

Next.js 服务器在 `instrumentation.ts` 中启动 connector broker：

```txt
NEXT server process
|-- connector WebSocket broker
|   |-- public WS /connect (Authorization: Bearer mcpcon_...)
|   |-- public WS /screen/source/:sessionId (connector Bearer)
|   |-- public WS /screen/view/:ticket (one-use browser ticket)
|   `-- internal HTTP /internal/connectors/...
`-- MCP supervisor
    `-- sandbox-mcp-server child processes
```

broker 监听：

```txt
CONNECTOR_WS_BIND        default 0.0.0.0
CONNECTOR_WS_PORT        default 9321
CONNECTOR_WS_PUBLIC_URL  optional explicit public ws:// or wss:// URL
```

`docker-compose.yml` 用 `APP_HOST_PORT`（默认 `10030`）发布应用 HTTP 端口，用
`CONNECTOR_WS_HOST_PORT`（默认 `9321`）发布 broker：

```yaml
app:
  ports:
    - '${APP_HOST_BIND:-0.0.0.0}:${APP_HOST_PORT:-10030}:3000'
    - '${CONNECTOR_WS_HOST_BIND:-0.0.0.0}:${CONNECTOR_WS_HOST_PORT:-9321}:9321'
```

生产环境在 Coolify 或其他反向代理后时，把 `/connect`、`/screen/source/*`、
`/screen/view/*` 连同 WebSocket 升级一起路由到 broker 发布的主机端口。把
`CONNECTOR_WS_PUBLIC_URL` 设为公开 WebSocket 源，例如：

```txt
wss://example.com
```

如果代理运行在另一台主机上，用主机防火墙把 broker 端口限制为该代理的 IP，或把
`CONNECTOR_WS_HOST_BIND` 设为合适的内网网卡。

所有生成的 connector 沙箱都存储：

```txt
connector.provider         = websocket
connector.protocolVersion  = 2026-07-connector-ws-v2
connector.serverUrl        = platform URL shown in the command
connector.remoteRoot       = root path returned by bootstrap
connector.tokenHash        = sha256(token)
connector.tokenPrefix      = short display prefix only
connector.packageName      = /api/v1/connectors/package.tgz
```

明文 token 通过一个短期、HttpOnly、strict-same-site、scope 到该沙箱页的 Cookie 交付给
设置页，不写入 URL。数据库只保存 token 哈希。轮换 token 会立即断开旧会话。

协议 v2 是对 connector `0.1.8` 及更早版本的破坏性升级。升级 ToolPlane 后，停止旧的
connector 进程，在沙箱页生成新命令并重新运行。旧进程会被有意拒绝，而不是静默使用不兼
容的文件或进程语义。

### 已禁用的遗留模式

数据库中可能仍有 `kind=host`、`kind=ssh` 或遗留 connector JSON 的旧记录以兼容，但不再
创建新的 host-root、直接 SSH 或反向隧道沙箱。请以 Docker Linux 或用户 Connector 沙箱重
建。

```txt
Legacy sandbox row
|-- kind=host       disabled
|-- kind=ssh        disabled
`-- legacy connector disabled
```

## Skill 脚本执行

当 Agent 同时拥有 skills 和沙箱时，`skill_run_script` 会先把 skill bundle 写入第一个绑
定的沙箱再执行：

```txt
.toolplane/skills/<skill-slug>/
|-- SKILL.md
|-- reference files
`-- scripts/*
```

二进制 bundle 文件使用 base64 编码的 `write_file`，由沙箱运行时解码，不经过 shell 命
令。脚本使用结构化的 `process_exec` 参数：Node.js 映射到 connector 当前的 Node 可执行
文件，Python 映射到原生 Python launcher/解释器，Bash 要求已安装 Bash。Windows 上把
`TOOLPLANE_CONNECTOR_BASH` 设为绝对可执行路径，如 `C:\\Program Files\\Git\\bin\\bash.exe`；
Python 不在 `PATH` 中时设置 `TOOLPLANE_CONNECTOR_PYTHON`。`TOOLPLANE_CONNECTOR_SHELL`
可选择绝对 `pwsh.exe` 路径，但交互式会话不支持 `cmd.exe`。这避免了 Windows 上对 POSIX
引号和 `base64 -d` 的假设。

没有绑定沙箱时，`skill_run_script` 返回错误，不回退宿主机执行。显式传入的 Sandbox ID 必须属于 Agent 的绑定集合。

## 数据库

```txt
Workspace 1-* Sandbox
Sandbox 1-1 Deployment
Agent *-* Sandbox via AgentSandbox
```

沙箱 deployment 就是 MCP supervisor 启动、停止、对账并暴露给 Agent 工具构建器的对象。
