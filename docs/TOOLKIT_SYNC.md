# Toolkit 同步机制

> **English**: [TOOLKIT_SYNC.en.md](./TOOLKIT_SYNC.en.md)

> 本文说明 Toolkit 如何同步到 Claude Code、Codex、opencode 和 Hermes，包括 MCP 工具、Skills、安装 token、客户端本地文件和测试覆盖。

下文路径用 `<installation>` 表示稳定标识 `toolplane-<24 个十六进制字符>`，由规范化服务 URL（包含 base path）、workspace ID 和 Toolkit ID 计算；显示名称不承担身份职责。`toolplane-0123456789abcdef01234567` 只是示意值，不是示例 URL 的实际哈希。旧的 slug 命名安装会保留；先登记并验证新安装，再显式撤销和移除旧安装。

---

## 1. 同步目标

Toolkit 是工作区里自由组装的一组资源：

1. `ToolkitServer`：指向已经部署的 MCP server，也就是 `Deployment`。
2. `ToolkitSkill`：指向工作区安装的 `InstalledSkill`。

同步到本地客户端时分两条通道：

| 通道 | 同步内容 | 原理 |
|---|---|---|
| MCP tools | Toolkit 里的所有 running deployments 暴露出来的 tools | 客户端配置一个远程 MCP endpoint，服务端在 `tools/list` 时动态聚合 |
| Skills | Toolkit 显式绑定的全部 Skill（包含 draft） | 本地安装脚本拉取 baseline，把每个 skill 写成一个 skill 目录，包含 `SKILL.md` 和 bundle 附带文件 |

MCP tools 不需要把每个 tool 写进本地文件。客户端只需要知道一个远程 MCP 地址：

```txt
/api/v1/workspaces/:workspace/toolkits/:toolkit/mcp
```

这个 endpoint 会在运行时读取 toolkit 绑定的 deployments，并通过 `listMcpTools()` 聚合每个正在运行的 MCP 子进程的 tools。

Skills 则不同。Claude Code 和 Codex 都有本地 skill 目录/插件机制，所以需要把远程 baseline 同步成文件目录。当前 ToolPlane 的 opencode 适配器采用远程 MCP、command 与本地 Skill 缓存；这不代表所有 opencode 版本都缺少原生 Skill 能力。

---

## 2. 主要代码入口

| 功能 | 文件 |
|---|---|
| Toolkit 安装面板 UI | `src/components/dashboard/ToolkitInstall.tsx` |
| 直接连接配置片段 | `src/lib/plugin/direct-config.ts` |
| 自动同步客户端列表 | `src/lib/plugin/clients.ts` |
| 安装链接发放 token | `src/lib/toolkits/install-link.ts` |
| public install link | `src/app/install/[id]/route.ts` |
| API token install endpoint | `src/app/api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/install/route.ts` |
| 安装脚本生成 | `src/lib/plugin/install-script.ts` |
| skill baseline 同步脚本 | `src/lib/plugin/sync-script.ts` |
| skill invocation telemetry 脚本 | `src/lib/plugin/skill-invocation-script.ts` |
| baseline API | `src/app/api/v1/plugin/baseline/route.ts` |
| GitHub skill bundle 导入 | `src/lib/skills/bundle.ts`、`src/app/admin/skills/import/page.tsx` |
| sync telemetry API | `src/app/api/v1/plugin/sync-applied/route.ts`、`sync-failure/route.ts` |
| skill invocation telemetry API | `src/app/api/v1/plugin/skill-invocation/route.ts` |
| Toolkit MCP gateway | `src/app/api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/mcp/route.ts` |

---

## 3. 安装身份与凭据生命周期

`/install/:id?client=<client>` 是具有签发凭据能力的不透明链接，需要保密。`GET` 只返回无 Token 的引导脚本，预览不会创建或轮换凭据。真正执行引导脚本时，才向 `/install/:id` 发起有大小限制的 JSON `POST`。

每个新设备/客户端登记独立的 `ToolkitInstallation` 和 Toolkit 专用 Token。重装使用本地私有 `installation.json` 与 `.mcp.json` 证明该登记的归属，仅知道 installation ID 不能轮换或撤销它。数据库只存 Token 哈希；生成的脚本和客户端配置必须携带凭据，因而以私有权限保存。

服务端在工作区行锁内重新校验用户、工作区 active 状态、成员关系、Toolkit enabled 状态、链接、客户端与安装登记。轮换与审计在同一事务完成。上一有效凭据获得最多五分钟宽限；已有宽限期不延长，每个登记最多保留三把密钥。每个用户/Toolkit 最多 100 个 active 登记。不同设备不再互相轮换凭据。

Toolkit 安装面板显示登记列表，可撤销单个、撤销当前用户在该 Toolkit 下的全部登记，或重新生成安装链接。重新生成链接使旧签发入口失效，但不撤销已安装凭据。成员移除与 Toolkit 删除仍会撤销对应访问。

引导脚本以客户端级锁串行更新共享配置，应用前保存私有 `pending-install.sh`，重试时先恢复该脚本。不要分享此文件，其中包含凭据。残留安装锁必须先确认原进程已经停止，再移除。首次登记响应丢失可能留下未使用的登记；在面板检查/撤销后重新登记，不承诺响应丢失时恰好一次登记。

不猜测或自动删除旧的 slug 命名安装。同类客户端在不同电脑上分别登记；主动复制凭据和状态目录到另一台设备，会共享同一登记，而不是自动产生新的设备身份。

---

## 4. MCP tools 同步原理

### 4.1 客户端看到的是一个 MCP server

无论 toolkit 内部有几个 deployed MCP，客户端都只配置一个 remote MCP server：

```txt
https://<app>/api/v1/workspaces/<workspace>/toolkits/<toolkit>/mcp
```

### 4.2 服务端运行时聚合 tools

当客户端调用：

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
```

Toolkit MCP gateway 会：

1. 校验当前用户是否能访问该 workspace/toolkit。
2. 读取 toolkit 绑定的 `ToolkitServer`。
3. 过滤掉没有 running 的 deployment。
4. 对每个 running deployment 调用 `listMcpTools(deploymentId)`。
5. 返回聚合后的 tools。

tool 名称会被命名空间化：

```txt
<deploymentId>__<toolName>
```

客户端调用：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "<deploymentId>__<toolName>",
    "arguments": {}
  }
}
```

gateway 会把前缀拆出来，路由回对应 deployment，再通过 `mcpRpc()` 调用真实 MCP 子进程。

### 4.3 为什么称为“同步”

MCP tools 不是写入本地文件的同步，而是配置一次远程 MCP server。之后 toolkit 里新增/移除 deployments，只要客户端重新拉取 `tools/list`，就会看到服务端最新状态。

有些客户端可能缓存 tool list，这时需要重启客户端或刷新 MCP server。

---

## 5. 完整校验与可恢复的 Skill 同步

```text
GET /api/v1/plugin/baseline?workspace=<workspace>&toolkit=<toolkit>
Authorization: Bearer <install-token>
```

baseline 返回带版本号的完整快照。示例：

```json
{
  "data": {
    "schemaVersion": 1,
    "snapshotComplete": true,
    "workspaceId": "workspace-id",
    "toolkitId": "toolkit-id",
    "workspaceSlug": "acme",
    "toolkitSlug": "devtools",
    "skills": [
      {
        "slug": "pdf",
        "version": "8de29c512544",
        "content": "---\nname: pdf\ndescription: Read PDFs\n---\n",
        "files": []
      }
    ]
  }
}
```

`version` 是 `JSON.stringify({ content, files })` 的 SHA-256 前 12 个十六进制字符。客户端校验它，并在本地记录完整摘要。文件条目包含 `path`、`content` 和可选的 `encoding: "base64"`；`SKILL.md` 由 `content` 表示，不在 `files` 重复。

baseline 导出所有显式绑定的 Skill，包含 `draft`，不根据 `userInvocable` 或 `agentInvocable` 过滤；artifact builder 把支持的调用元数据写入 SKILL.md。这不同于平台内 Agent 的资源解析，后者有自己的 `agentInvocable` 选择规则。授权分发不等于批准执行。

`sync.sh` 下载到私有、有限大小的临时文件，不通过环境变量搬运 bundle。`sync-client.ts` 在修改当前版本前，校验 schema/version、完整快照标记、workspace/Toolkit 身份、Skill 名称唯一性、文件路径、编码和哈希。缺少 `data.skills` 是错误，不是空 Toolkit。合法空快照只移除本安装拥有的 Skill。

响应和总内容限制为 32 MiB，单文件 8 MiB，每快照最多 1,000 个 Skill、20,000 个文件。绝对路径、路径穿越、保留名称、重复/冲突名称，以及受管位置的符号链接均会被拒绝。

安装级进程锁串行化同步，新内容先写入同文件系统的 staging，恢复日志和备份保护提交过程，以 manifest generation 作为提交点。进程中断或更新失败后，下次运行先恢复，再接受新快照。这是可恢复的多目录更新，不宣称所有客户端目录对读者瞬间原子切换。

`<skills-root>/.toolplane-state/<installation>/manifest.json` 记录准确归属目录、已应用哈希和上次成功时间；`last-attempt.json` 记录成功/失败状态。未变化的哈希会跳过，清理不再依赖可能重叠的 Toolkit 名称前缀，也不会覆盖无归属目录。Hook 可以在同步失败时继续聊天，但外层 hook 退出 0 不代表刷新成功。

### 5.1 真实 skill 仓库导入

后台的 skill import 支持两种输入：

```txt
anthropics/skills/skills/pdf
https://github.com/anthropics/skills/tree/main/skills/pdf
```

导入流程在 `fetchGithubSkillBundle()` 中完成：

1. 解析 GitHub owner/repo/ref/path。
2. 通过 GitHub Contents API 递归读取目标目录。
3. 要求目录内必须存在 `SKILL.md`。
4. 从 `SKILL.md` frontmatter 提取 `name`、`description`、`author`。
5. 将 `SKILL.md` 存入 `Skill.content`。
6. 将其它安全路径下的文本文件存入 `Skill.files`。

安全限制：

1. 导入阶段不会执行仓库脚本，也不会执行 `npm install`、`npx`、`uvx`。
2. 单文件大小、总 bundle 大小和文件数量都有上限。
3. 不允许绝对路径、空路径、路径穿越、`.git`、`node_modules`。
4. 同步到客户端时会再次校验路径，即使服务端数据异常也不会写到 skill 目录外。

因此，像 Anthropic PDF skill 这种包含 `scripts/` 的仓库可以作为 bundle 导入，脚本会原样随 skill 同步到 Claude Code、Codex、opencode cache 或 Hermes skills 目录。需要通过 `npx` 调用的能力应写在 `SKILL.md` 指令里，或者建成 MCP server 的 `installCommand`/部署配置；market 导入本身只负责保存和分发 skill 文件，不负责执行远端包安装。

---

## 6. Claude Code 自动同步

Claude Code 使用本地插件机制。

安装后文件结构：

```txt
~/.claude/plugins/<installation>/
├─ .claude-plugin/
│  ├─ marketplace.json
│  └─ plugin.json
├─ .mcp.json
├─ hooks/
│  └─ hooks.json
├─ shared/
│  ├─ sync.sh
│  └─ skill-invocation.sh
└─ skills/
   └─ <skill-slug>/
      ├─ SKILL.md
      └─ scripts/...
```

安装脚本会执行：

```bash
claude plugin marketplace add "$PLUGIN_DIR"
claude plugin uninstall <installation>@<installation> || true
claude plugin install <installation>@<installation>
```

### MCP tools

`.mcp.json` 内容类似：

```json
{
  "mcpServers": {
    "toolplane-0123456789abcdef01234567": {
      "url": "https://app/api/v1/workspaces/ws/toolkits/devtools/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

### Skills

`hooks/hooks.json` 注册 `SessionStart` hook：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PLUGIN_ROOT}/shared/sync.sh\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

每次 Claude Code session start 时，`sync.sh` 会刷新 `skills/<slug>/SKILL.md` 和该 skill 的附带文件。

### Skill telemetry

Claude Code 还会注册：

```txt
PostToolUse
PostToolUseFailure
```

matcher 是 `Skill`，只记录 Skill tool 的调用。`skill-invocation.sh` 会把 skill slug、来源、成功/失败、错误类型上报到：

```txt
POST /api/v1/plugin/skill-invocation
```

---

## 7. Codex 自动同步

Codex 使用用户级 MCP config + 用户级 hook + 用户级 skills。

安装后文件结构：

```txt
$CODEX_HOME or ~/.codex/
├─ config.toml
├─ hooks.json
└─ toolplane/
   └─ <installation>/
      ├─ .mcp.json
      └─ shared/
         └─ sync.sh

~/.agents/skills/
└─ <installation>-<skill-slug>/
   ├─ SKILL.md
   └─ scripts/...
```

### MCP tools

安装脚本会在 `~/.codex/config.toml` 写入一个带 marker 的 block：

```toml
# BEGIN TOOLPLANE toolplane-0123456789abcdef01234567
[mcp_servers.toolplane-0123456789abcdef01234567]
url = "https://app/api/v1/workspaces/ws/toolkits/devtools/mcp"
http_headers = { Authorization = "Bearer <token>" }
enabled = true
# END TOOLPLANE toolplane-0123456789abcdef01234567
```

重新安装同一个 toolkit 时，会先删除旧 marker block，再写新 block，避免重复配置。

### Skills

安装脚本会在 `~/.codex/hooks.json` 写入 `SessionStart` hook：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$HOME/.codex/toolplane/toolplane-0123456789abcdef01234567/shared/sync.sh\"",
            "timeout": 30,
            "statusMessage": "Syncing ToolPlane toolkit toolplane-0123456789abcdef01234567"
          }
        ]
      }
    ]
  }
}
```

`sync.sh` 会把 skills 写入：

```txt
~/.agents/skills/<installation>-<skill-slug>/SKILL.md
```

如果 skill 有 bundle 附带文件，它们会写在同一个 skill 目录下，例如 `scripts/convert_pdf_to_images.py`。Codex 会从用户级 `~/.agents/skills` 发现这些 skills。Codex 的 hook 需要用户信任：首次安装或 hook 内容变化后，用户可能需要在 Codex 中打开 `/hooks` 审核并 trust。

当前 Codex 同步只做：

1. MCP tools 配置。
2. Skills 文件同步。

暂未做 Codex skill invocation telemetry，因为 Codex 的 skill 调用事件模型和 Claude Code 的 `Skill` tool hook 不同。

---

## 8. opencode 自动同步

当前 ToolPlane 的 opencode 适配器采用远程 MCP、command 与本地 Skill 缓存；这不代表所有 opencode 版本都缺少原生 Skill 能力。

1. MCP tools：原生 remote MCP。
2. Skills：同步成本地 cache。
3. command：生成一个 toolkit command，引导 opencode 读取本地 cache。

安装后文件结构：

```txt
$OPENCODE_CONFIG_DIR or ~/.config/opencode/
├─ opencode.json
└─ toolplane/
   └─ <installation>/
      ├─ .mcp.json
      ├─ shared/
      │  └─ sync.sh
      └─ skills/
         └─ <skill-slug>/
            ├─ SKILL.md
            └─ scripts/...
```

如果设置了 `OPENCODE_CONFIG`，则配置写入该路径；否则写入：

```txt
$OPENCODE_CONFIG_DIR/opencode.json
```

### MCP tools

安装脚本会写入：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "toolplane-0123456789abcdef01234567": {
      "type": "remote",
      "url": "https://app/api/v1/workspaces/ws/toolkits/devtools/mcp",
      "enabled": true,
      "oauth": false,
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

### Skills

`sync.sh` 会把 skills 写入：

```txt
~/.config/opencode/toolplane/<installation>/skills/<skill-slug>/SKILL.md
```

如果 skill 有 bundle 附带文件，它们会写在同一个 cache 目录下。

同时安装脚本会维护一个 command：

```json
{
  "command": {
    "toolplane-0123456789abcdef01234567": {
      "description": "Use ToolPlane toolkit devtools skills",
      "template": "Use the ToolPlane toolkit \"devtools\".\nBefore answering, inspect the relevant synced SKILL.md files under:\n...\n\nUser request:\n$ARGUMENTS"
    }
  }
}
```

使用方式：

```txt
/<installation> <task>
```

这不是隐式 skill 自动触发，而是显式 command 触发。后续如果 opencode 支持 open agent skills 或更完整的 prompt/session hooks，可以把这层升级成更接近 Codex 的体验。

---

## 9. Hermes 自动同步

Hermes 原生支持 remote HTTP MCP，也有本地 skills 目录和 skill bundles。因此这里采用：

1. MCP tools：写入 `~/.hermes/config.yaml` 的 `mcp_servers`。
2. Skills：同步到 `~/.hermes/skills/<installation>/` 下；目录名优先使用 `SKILL.md` frontmatter 的 `name`，避免 Hermes prompt 里显示长 slug。
3. Bundle：写入 `~/.hermes/skill-bundles/<installation>.yaml`，把本 toolkit 同步出的 skills 组织成一个 Hermes bundle。
4. Hook：写入 `hooks.on_session_start`，新 session 开始时静默运行同步脚本。

安装后文件结构：

```txt
$HERMES_HOME or ~/.hermes/
├─ config.yaml
├─ skill-bundles/
│  └─ <installation>.yaml
├─ skills/
│  └─ <installation>/
│     └─ <skill-name>/
│        ├─ SKILL.md
│        └─ scripts/...
└─ toolplane/
   └─ <installation>/
      ├─ .mcp.json
      └─ shared/
         ├─ hook-sync.sh
         └─ sync.sh
```

如果设置了 `HERMES_CONFIG`，则配置写入该路径；否则写入：

```txt
$HERMES_HOME/config.yaml
```

如果没有设置 `HERMES_HOME`，默认是：

```txt
~/.hermes/config.yaml
```

### MCP tools

安装脚本会在 `config.yaml` 的 `mcp_servers` 下写入一个 marker block：

```yaml
mcp_servers:
  # BEGIN TOOLPLANE toolplane-0123456789abcdef01234567
  toolplane-0123456789abcdef01234567:
    url: "https://app/api/v1/workspaces/ws/toolkits/devtools/mcp"
    headers:
      Authorization: "Bearer <token>"
  # END TOOLPLANE toolplane-0123456789abcdef01234567
```

重新安装同一个 toolkit 时，会先删除旧 marker block，再写新 block，避免重复配置。

### Skills 与 bundle

`sync.sh` 会把 skills 写入：

```txt
~/.hermes/skills/<installation>/<skill-name>/SKILL.md
```

Hermes 查找 skill 时目录名很重要，但 prompt 展示又使用 `SKILL.md` 的 `name`。因此 Hermes 同步路径会读取 frontmatter `name` 作为目录名；如果缺失或不安全，再退回 baseline slug。如果 skill 有 bundle 附带文件，它们会写在同一个 skill 目录下。

同步完成后安装脚本从已提交的归属 manifest 生成 bundle，不扫描状态目录或相邻手工 Skill：

```yaml
name: toolplane-0123456789abcdef01234567
description: "ToolPlane toolkit devtools"
skills:
  - toolplane-0123456789abcdef01234567/pdf
  - toolplane-0123456789abcdef01234567/github
instruction: |
  Use the ToolPlane toolkit "devtools".
  Its MCP tools are available through the "toolplane-0123456789abcdef01234567" MCP server.
```

如果本机有 `hermes` CLI，安装脚本会执行：

```bash
hermes bundles reload
```

### 自动同步 hook

安装脚本还会在 `config.yaml` 里写入同一个 marker block 下的 shell hook：

```yaml
hooks:
  on_session_start:
    # BEGIN TOOLPLANE toolplane-0123456789abcdef01234567
    - command: "bash $HOME/.hermes/toolplane/toolplane-0123456789abcdef01234567/shared/hook-sync.sh"
      timeout: 30
    # END TOOLPLANE toolplane-0123456789abcdef01234567
```

`hook-sync.sh` 会：

1. 丢弃 Hermes 传入的 hook JSON payload。
2. 静默运行 `shared/sync.sh`。
3. 按已提交 manifest 的归属目录重写 `skill-bundles/<installation>.yaml`。
4. 删除 `.skills_prompt_snapshot.json`，让下一次 prompt 重新读取最新 skills index。
5. 输出 `{}`，满足 Hermes shell hook stdout JSON 协议且不注入额外上下文。

首次运行该 hook 时，Hermes 可能要求用户 approve；也可以用 `--accept-hooks` 或 `HERMES_ACCEPT_HOOKS=1` 预批准。安装脚本仍会安装时同步一次，并留下手动同步入口：

```bash
~/.hermes/toolplane/<installation>/shared/sync.sh
```

运行中的 Hermes session 需要手动执行：

```txt
/reload-mcp
/reload-skills
```

---

## 10. Direct connection 与 Auto-sync 的区别

Toolkit 安装面板有两个 tab：

| Tab | 用途 | 是否同步 skills |
|---|---|---|
| Auto-sync | 返回 bash installer，写入本地客户端配置和 sync 脚本 | 是 |
| Direct connection | 只展示手动 MCP 配置片段 | 否 |

Direct connection 只适合快速把 toolkit 作为一个 remote MCP server 连到客户端。它不会创建 install token，也不会写本地 `SKILL.md`。

Auto-sync 才是完整的“tools + skills”同步路径。

---

## 11. 卸载行为

`GET /install/:id/uninstall?client=<client>` 返回无 Token 的引导脚本，不撤销凭据。运行时用当前登记的凭据证明归属，只撤销该安装，并执行所选客户端的清理。撤销重试是幂等的；撤销全部安装是独立的面板操作。

清理只移除所选客户端受管的 MCP 配置块/键、同步 hook、安装器拥有的文件，以及 manifest 记录的 Skill。其他客户端、其他安装、相邻手工 Skill 和用户创建的文件保留。空的受管目录可以移除，非空目录保留。manifest 损坏、状态符号链接或尚有同步恢复日志时停止清理，不猜测归属。

旧安装目录没有新的可验证归属，因此保留。验证新登记后再显式处理旧目录。服务端撤销不等于已删除离线设备上的缓存文件。

---

## 12. 安全边界

- 个人 Token 与 Toolkit 安装 Token 是不同的 principal。Toolkit 端点保留并校验 scope；account 和 Agent Control 接口拒绝 Toolkit Token。显式无效 Bearer 不回退 Cookie。
- 安装链接即使不保存明文 Token，仍是签发能力。泄露后重新生成链接，检查登记并另行撤销受影响的 Token。
- 轮换/撤销始终绑定用户、Toolkit、客户端和安装登记；客户端自报设备备注只是显示信息，不用于授权。
- 本地 JSON 无效或 YAML 结构不支持时停止，不以空配置覆盖；受管标记必须成对。manifest 之外的文件不删除。
- 下载、哈希和路径校验保证更新完整性，不会把任意 Skill 指令或脚本变成可信内容。客户端执行仍遵守自身权限和信任控制。

---

## 13. 测试覆盖

相关测试：

| 测试 | 覆盖点 |
|---|---|
| `tests/unit/plugin-install-script.test.ts` | client 解析、脚本内容、Codex/opencode/Hermes 分发 |
| `tests/unit/plugin-install-flow.test.ts` | 真实执行生成的 bash installer，验证本地文件落盘 |
| `tests/unit/plugin-direct-config.test.ts` | Direct connection 配置片段 |
| `tests/unit/plugin-telemetry-scripts.test.ts` | sync 和 skill invocation shell 脚本内容 |
| `tests/unit/skill-bundle.test.ts` | GitHub skill bundle URL 解析、frontmatter、路径安全和递归导入 |
| `tests/integration/toolkit-install-link.test.ts` | opaque install link、事务轮换、installation 独立 Token |
| `tests/integration/plugin-baseline.test.ts` | baseline 权限、内容过滤和 bundle 文件返回 |
| `tests/integration/plugin-telemetry.test.ts` | sync/skill telemetry API |

新增回归：`tests/unit/toolkit-principal.test.ts`、`tests/unit/toolkit-sync-transaction.test.ts` 和 `tests/unit/documentation-contracts.test.ts`。

推荐验证命令：

```bash
pnpm vitest run \
  tests/unit/plugin-install-script.test.ts \
  tests/unit/plugin-install-flow.test.ts \
  tests/unit/plugin-direct-config.test.ts \
  tests/unit/plugin-telemetry-scripts.test.ts \
  tests/unit/skill-bundle.test.ts \
  tests/integration/toolkit-install-link.test.ts \
  tests/integration/plugin-baseline.test.ts \
  tests/integration/plugin-telemetry.test.ts

pnpm lint
pnpm build
pnpm test
```

---

## 14. 后续扩展

可继续增加安装 dry-run、显式旧安装迁移引导，以及在 UI 中展示更完整的本地成功/失败状态。客户端原生能力可能独立演进，调整适配器前应验证实际客户端版本。当前同步已跳过未变化哈希，并在本地保存恢复与状态元数据。

---
