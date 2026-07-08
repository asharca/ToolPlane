# Toolkit 同步机制

> 本文说明 Toolkit 如何同步到 Claude Code、Codex、opencode 和 Hermes，包括 MCP 工具、Skills、安装 token、客户端本地文件和测试覆盖。

---

## 1. 同步目标

Toolkit 是工作区里自由组装的一组资源：

1. `ToolkitServer`：指向已经部署的 MCP server，也就是 `Deployment`。
2. `ToolkitSkill`：指向工作区安装的 `InstalledSkill`。

同步到本地客户端时分两条通道：

| 通道 | 同步内容 | 原理 |
|---|---|---|
| MCP tools | Toolkit 里的所有 running deployments 暴露出来的 tools | 客户端配置一个远程 MCP endpoint，服务端在 `tools/list` 时动态聚合 |
| Skills | Toolkit 里的 published skills | 本地安装脚本拉取 baseline，把每个 skill 写成一个 skill 目录，包含 `SKILL.md` 和 bundle 附带文件 |

MCP tools 不需要把每个 tool 写进本地文件。客户端只需要知道一个远程 MCP 地址：

```txt
/api/v1/workspaces/:workspace/toolkits/:toolkit/mcp
```

这个 endpoint 会在运行时读取 toolkit 绑定的 deployments，并通过 `listMcpTools()` 聚合每个正在运行的 MCP 子进程的 tools。

Skills 则不同。Claude Code 和 Codex 都有本地 skill 目录/插件机制，所以需要把远程 baseline 同步成文件目录。opencode 目前没有同等的 Agent Skills 自动发现机制，因此采用“远程 MCP + command + 本地 skill cache”的兼容方案。

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

## 3. 安装链接和 token 生命周期

Toolkit 页面会生成一个 opaque install link：

```txt
/install/:id
```

`ToolkitInstallLink` 只保存 `id -> toolkitId + userId` 的映射，不保存明文 token。

每次访问安装链接时：

1. `src/app/install/[id]/route.ts` 读取 `?client=`。
2. `resolveClient()` 将 client 规整到：
   - `claude-code`
   - `codex`
   - `opencode`
   - `hermes`
3. `issueInstallToken(id, client)` 给当前 toolkit 和客户端 mint 一个新的 API token。
4. 同名旧 token 会先删除，再创建新 token。
5. 明文 token 只会被嵌入这一次返回的 bash 安装脚本。

token 名称格式：

```txt
ToolPlane plugin - <toolkitSlug> (<Client Label>)
```

例如：

```txt
ToolPlane plugin - devtools (Claude Code)
ToolPlane plugin - devtools (Codex)
ToolPlane plugin - devtools (opencode)
ToolPlane plugin - devtools (Hermes)
```

这样同一个 toolkit 可以同时安装到多个客户端，互相不会覆盖 token。

卸载链接：

```txt
/install/:id/uninstall
```

会删除这个 toolkit 下所有安装客户端的 token，并返回一个本地清理脚本。

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

## 5. Skills 同步原理

Skills 通过 baseline API 同步：

```txt
GET /api/v1/plugin/baseline?workspace=<workspace>&toolkit=<toolkit>
Authorization: Bearer <install-token>
```

返回格式：

```json
{
  "data": {
    "skills": [
      {
        "slug": "pdf",
        "version": "a1b2c3d4e5f6",
        "content": "---\nname: pdf\n...",
        "files": [
          {
            "path": "scripts/convert_pdf_to_images.py",
            "content": "..."
          },
          {
            "path": "references/layout-notes.md",
            "content": "..."
          }
        ]
      }
    ]
  }
}
```

baseline API 只返回：

1. 当前 token 用户有权限访问的 workspace/toolkit。
2. toolkit 中 status 不是 `draft` 的 skills。
3. 经过 `buildInstalledSkillMarkdown()` 生成的完整 `SKILL.md` 内容。真实仓库导入的 skill 会优先使用仓库原始 `SKILL.md`。
4. `files` 是随 skill 一起同步的附带文件，例如 `scripts/*.py`、`references/*.md`。`SKILL.md` 本身不重复放进 `files`。
5. `version` 是 `content + files` 的 hash，方便未来做跳过未变更文件的优化。

安装脚本会把 `sync.sh` 写到客户端本地。`sync.sh` 做这些事：

1. 从本地 `.mcp.json` 读取 Bearer token。
2. 请求 baseline API。
3. 校验 skill slug，阻止路径穿越。
4. 删除并重建本地 skill 目录，写入 `SKILL.md`。
5. 写入 bundle 附带文件，并再次做路径校验，阻止绝对路径、`..`、`.git`、`node_modules` 等不安全路径。
6. 删除已经不在 baseline 中的旧 skill 目录。
7. 上报 sync-applied 或 sync-failure telemetry。

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
~/.claude/plugins/toolplane-<toolkit>/
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
claude plugin uninstall toolplane-<toolkit>@toolplane-<toolkit> || true
claude plugin install toolplane-<toolkit>@toolplane-<toolkit>
```

### MCP tools

`.mcp.json` 内容类似：

```json
{
  "mcpServers": {
    "toolplane-devtools": {
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
   └─ toolplane-<toolkit>/
      ├─ .mcp.json
      └─ shared/
         └─ sync.sh

~/.agents/skills/
└─ toolplane-<toolkit>-<skill-slug>/
   ├─ SKILL.md
   └─ scripts/...
```

### MCP tools

安装脚本会在 `~/.codex/config.toml` 写入一个带 marker 的 block：

```toml
# BEGIN TOOLPLANE toolplane-devtools
[mcp_servers.toolplane-devtools]
url = "https://app/api/v1/workspaces/ws/toolkits/devtools/mcp"
http_headers = { Authorization = "Bearer <token>" }
enabled = true
# END TOOLPLANE toolplane-devtools
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
            "command": "bash \"~/.codex/toolplane/toolplane-devtools/shared/sync.sh\"",
            "timeout": 30,
            "statusMessage": "Syncing ToolPlane toolkit toolplane-devtools"
          }
        ]
      }
    ]
  }
}
```

`sync.sh` 会把 skills 写入：

```txt
~/.agents/skills/toolplane-<toolkit>-<skill-slug>/SKILL.md
```

如果 skill 有 bundle 附带文件，它们会写在同一个 skill 目录下，例如 `scripts/convert_pdf_to_images.py`。Codex 会从用户级 `~/.agents/skills` 发现这些 skills。Codex 的 hook 需要用户信任：首次安装或 hook 内容变化后，用户可能需要在 Codex 中打开 `/hooks` 审核并 trust。

当前 Codex 同步只做：

1. MCP tools 配置。
2. Skills 文件同步。

暂未做 Codex skill invocation telemetry，因为 Codex 的 skill 调用事件模型和 Claude Code 的 `Skill` tool hook 不同。

---

## 8. opencode 自动同步

opencode 目前支持 remote MCP 和 custom command，但没有和 Codex Agent Skills 等价的自动 skill 发现机制。因此这里采用兼容同步：

1. MCP tools：原生 remote MCP。
2. Skills：同步成本地 cache。
3. command：生成一个 toolkit command，引导 opencode 读取本地 cache。

安装后文件结构：

```txt
$OPENCODE_CONFIG_DIR or ~/.config/opencode/
├─ opencode.json
└─ toolplane/
   └─ toolplane-<toolkit>/
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
    "toolplane-devtools": {
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
~/.config/opencode/toolplane/toolplane-<toolkit>/skills/<skill-slug>/SKILL.md
```

如果 skill 有 bundle 附带文件，它们会写在同一个 cache 目录下。

同时安装脚本会维护一个 command：

```json
{
  "command": {
    "toolplane-devtools": {
      "description": "Use ToolPlane toolkit devtools skills",
      "template": "Use the ToolPlane toolkit \"devtools\".\nBefore answering, inspect the relevant synced SKILL.md files under:\n...\n\nUser request:\n$ARGUMENTS"
    }
  }
}
```

使用方式：

```txt
/toolplane-<toolkit> <task>
```

这不是隐式 skill 自动触发，而是显式 command 触发。后续如果 opencode 支持 open agent skills 或更完整的 prompt/session hooks，可以把这层升级成更接近 Codex 的体验。

---

## 9. Hermes 自动同步

Hermes 原生支持 remote HTTP MCP，也有本地 skills 目录和 skill bundles。因此这里采用：

1. MCP tools：写入 `~/.hermes/config.yaml` 的 `mcp_servers`。
2. Skills：同步到 `~/.hermes/skills/toolplane/` 下的 ToolPlane category。
3. Bundle：写入 `~/.hermes/skill-bundles/toolplane-<toolkit>.yaml`，把本 toolkit 同步出的 skills 组织成一个 Hermes bundle。

安装后文件结构：

```txt
$HERMES_HOME or ~/.hermes/
├─ config.yaml
├─ skill-bundles/
│  └─ toolplane-<toolkit>.yaml
├─ skills/
│  └─ toolplane/
│     └─ toolplane-<toolkit>-<skill-slug>/
│        ├─ SKILL.md
│        └─ scripts/...
└─ toolplane/
   └─ toolplane-<toolkit>/
      ├─ .mcp.json
      └─ shared/
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
  # BEGIN TOOLPLANE toolplane-devtools
  toolplane-devtools:
    url: "https://app/api/v1/workspaces/ws/toolkits/devtools/mcp"
    headers:
      Authorization: "Bearer <token>"
  # END TOOLPLANE toolplane-devtools
```

重新安装同一个 toolkit 时，会先删除旧 marker block，再写新 block，避免重复配置。

### Skills 与 bundle

`sync.sh` 会把 skills 写入：

```txt
~/.hermes/skills/toolplane/toolplane-<toolkit>-<skill-slug>/SKILL.md
```

如果 skill 有 bundle 附带文件，它们会写在同一个 skill 目录下。

同步完成后安装脚本会扫描这些目录并写入 bundle：

```yaml
name: toolplane-devtools
description: "ToolPlane toolkit devtools"
skills:
  - toolplane-devtools-pdf
  - toolplane-devtools-github
instruction: |
  Use the ToolPlane toolkit "devtools".
  Its MCP tools are available through the "toolplane-devtools" MCP server.
```

如果本机有 `hermes` CLI，安装脚本会执行：

```bash
hermes bundles reload
```

Hermes 文档暴露的是运行中 slash command，而不是可写入的 SessionStart hook。因此安装脚本会安装时同步一次，并留下：

```bash
~/.hermes/toolplane/toolplane-<toolkit>/shared/sync.sh
```

运行中的 Hermes session 需要手动执行：

```txt
/reload-mcp
/reload-skills
```

如果后续 Hermes 支持启动 hook 或后台 sync command，可以把这层升级成真正的 session-start 自动刷新。

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

卸载脚本会尽量清理四类客户端：

1. Claude Code：
   - `claude plugin uninstall`
   - `claude plugin marketplace remove`
   - 删除 `~/.claude/plugins/toolplane-<toolkit>`

2. Codex：
   - 删除 `config.toml` 中的 marker block
   - 删除 `hooks.json` 中对应 `sync.sh` hook
   - 删除 `~/.agents/skills/toolplane-<toolkit>-*`
   - 删除 `~/.codex/toolplane/toolplane-<toolkit>`

3. opencode：
   - 删除 `opencode.json` 中的 `mcp[server]`
   - 删除 `command[server]`
   - 删除本地 cache bundle

4. Hermes：
   - 删除 `config.yaml` 中的 marker block
   - 删除 `~/.hermes/skills/toolplane/toolplane-<toolkit>-*`
   - 删除 `~/.hermes/skill-bundles/toolplane-<toolkit>.yaml`
   - 删除 `~/.hermes/toolplane/toolplane-<toolkit>`

服务端会同时 revoke 这个 toolkit 下所有 install token。

---

## 12. 安全边界

必须保持这些约束：

1. install link 本身只保存 opaque id，不保存明文 token。
2. 明文 token 只在安装脚本响应中出现一次。
3. token 按 toolkit + client 独立命名和轮换。
4. baseline API 必须校验 token 用户是否属于 workspace。
5. MCP gateway 必须校验 toolkit 属于调用者 workspace。
6. `sync.sh` 必须校验 skill slug 和 bundle 文件路径，防止路径穿越。
7. uninstall 应该 revoke toolkit 下全部 install token。
8. 本地配置合并必须尽量局部：Codex 和 Hermes 使用 marker block，opencode 只覆盖对应 `mcp[server]` 和 `command[server]`。

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
| `tests/integration/toolkit-install-link.test.ts` | opaque install link、token 轮换、client 独立 token |
| `tests/integration/plugin-baseline.test.ts` | baseline 权限、内容过滤和 bundle 文件返回 |
| `tests/integration/plugin-telemetry.test.ts` | sync/skill telemetry API |

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

## 14. 后续可优化点

1. `sync.sh` 可以利用 baseline `version` 跳过未变化的 `SKILL.md` 写入。
2. Codex 可以进一步改成本地 plugin 分发，但目前 `config.toml + hooks.json + ~/.agents/skills` 更直接、可测试。
3. opencode 如果未来支持 open agent skills，可从 command/cache 模式升级到原生 skills。
4. 可以给 install 脚本增加 `--dry-run`，展示将写入哪些文件。
5. 可以在 UI 中展示“上次同步时间/失败原因”，读取 `SyncEvent`。
