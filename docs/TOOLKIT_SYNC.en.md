# Toolkit Sync Mechanism

> **中文**：[TOOLKIT_SYNC.md](./TOOLKIT_SYNC.md)
>
> This document explains how Toolkits sync to Claude Code, Codex, opencode, and Hermes: MCP tools, Skills, install tokens, client-side local files, and test coverage.

---

## 1. Sync Targets

A Toolkit is a freely assembled set of resources in a workspace:

1. `ToolkitServer`: points to a deployed MCP server, i.e. a `Deployment`.
2. `ToolkitSkill`: points to an `InstalledSkill` in the workspace.

Syncing to a local client happens over two channels:

| Channel | What syncs | How |
|---|---|---|
| MCP tools | All tools exposed by the toolkit's running deployments | The client configures one remote MCP endpoint; the server aggregates dynamically at `tools/list` |
| Skills | The toolkit's published skills | A local install script pulls the baseline and writes each skill as a skill directory containing `SKILL.md` plus bundle files |

MCP tools are not written into local files. The client only needs one remote MCP URL:

```txt
/api/v1/workspaces/:workspace/toolkits/:toolkit/mcp
```

This endpoint reads the toolkit's bound deployments at runtime and aggregates the tools of every running MCP child process via `listMcpTools()`.

Skills are different. Claude Code and Codex both have local skill directory/plugin mechanisms, so the remote baseline must be synced into file directories. opencode has no equivalent Agent Skills auto-discovery, so it uses a compatibility scheme of "remote MCP + command + local skill cache".

---

## 2. Main Code Entry Points

| Function | File |
|---|---|
| Toolkit install panel UI | `src/components/dashboard/ToolkitInstall.tsx` |
| Direct-connection config snippets | `src/lib/plugin/direct-config.ts` |
| Auto-sync client list | `src/lib/plugin/clients.ts` |
| Install-link token issuance | `src/lib/toolkits/install-link.ts` |
| Public install link | `src/app/install/[id]/route.ts` |
| API-token install endpoint | `src/app/api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/install/route.ts` |
| Install script generation | `src/lib/plugin/install-script.ts` |
| Skill baseline sync script | `src/lib/plugin/sync-script.ts` |
| Skill invocation telemetry script | `src/lib/plugin/skill-invocation-script.ts` |
| Baseline API | `src/app/api/v1/plugin/baseline/route.ts` |
| GitHub skill bundle import | `src/lib/skills/bundle.ts`, `src/app/admin/skills/import/page.tsx` |
| Sync telemetry API | `src/app/api/v1/plugin/sync-applied/route.ts`, `sync-failure/route.ts` |
| Skill invocation telemetry API | `src/app/api/v1/plugin/skill-invocation/route.ts` |
| Toolkit MCP gateway | `src/app/api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/mcp/route.ts` |

---

## 3. Install Links and Token Lifecycle

The Toolkit page generates an opaque install link:

```txt
/install/:id
```

`ToolkitInstallLink` stores only the `id -> toolkitId + userId` mapping — no plaintext token.

On each visit to an install link:

1. `src/app/install/[id]/route.ts` reads `?client=`.
2. `resolveClient()` normalizes the client to one of:
   - `claude-code`
   - `codex`
   - `opencode`
   - `hermes`
3. `issueInstallToken(id, client)` mints a fresh API token for this toolkit and client.
4. Any old token with the same name is deleted first, then the new token is created.
5. The plaintext token appears only inside the bash install script returned this once.

Token name format:

```txt
ToolPlane plugin - <toolkitSlug> (<Client Label>)
```

For example:

```txt
ToolPlane plugin - devtools (Claude Code)
ToolPlane plugin - devtools (Codex)
ToolPlane plugin - devtools (opencode)
ToolPlane plugin - devtools (Hermes)
```

This lets one toolkit install into multiple clients at once without tokens overwriting each other.

The uninstall link:

```txt
/install/:id/uninstall
```

deletes this toolkit's tokens for every installed client and returns a local cleanup script.

---

## 4. How MCP Tools Sync

### 4.1 The client sees one MCP server

No matter how many MCPs are deployed inside the toolkit, the client configures a single remote MCP server:

```txt
https://<app>/api/v1/workspaces/<workspace>/toolkits/<toolkit>/mcp
```

### 4.2 The server aggregates tools at runtime

When the client calls:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
```

the Toolkit MCP gateway:

1. Verifies the current user can access the workspace/toolkit.
2. Reads the toolkit's bound `ToolkitServer`s.
3. Filters out deployments that are not running.
4. Calls `listMcpTools(deploymentId)` for each running deployment.
5. Returns the aggregated tools.

Tool names are namespaced:

```txt
<deploymentId>__<toolName>
```

When the client calls:

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

the gateway strips the prefix, routes back to the matching deployment, and calls the real MCP child process via `mcpRpc()`.

### 4.3 Why this counts as "sync"

MCP tools are not synced by writing local files — you configure one remote MCP server once. Afterwards, adding/removing deployments in the toolkit is visible to the client as soon as it re-fetches `tools/list`.

Some clients cache the tool list; those need a client restart or an MCP server refresh.

---

## 5. How Skills Sync

Skills sync through the baseline API:

```txt
GET /api/v1/plugin/baseline?workspace=<workspace>&toolkit=<toolkit>
Authorization: Bearer <install-token>
```

Response shape:

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

The baseline API only returns:

1. The workspace/toolkit the token's user may access.
2. Skills in the toolkit whose status is not `draft`.
3. Full `SKILL.md` content built by `buildInstalledSkillMarkdown()`. Skills imported from a real repo prefer the repo's original `SKILL.md`.
4. `files`: companion files synced with the skill, e.g. `scripts/*.py`, `references/*.md`. `SKILL.md` itself is not duplicated into `files`.
5. `version`: a hash of `content + files`, enabling a future skip-unchanged optimization.

The install script writes `sync.sh` onto the client. `sync.sh`:

1. Reads the Bearer token from the local `.mcp.json`.
2. Calls the baseline API.
3. Validates skill slugs, blocking path traversal.
4. Deletes and rebuilds local skill directories, writing `SKILL.md`.
5. Writes bundle companion files, re-validating paths to block absolute paths, `..`, `.git`, `node_modules`, and other unsafe paths.
6. Removes stale skill directories no longer in the baseline.
7. Reports sync-applied or sync-failure telemetry.

### 5.1 Importing real skill repositories

The admin skill import accepts two input forms:

```txt
anthropics/skills/skills/pdf
https://github.com/anthropics/skills/tree/main/skills/pdf
```

The import flow runs in `fetchGithubSkillBundle()`:

1. Parse GitHub owner/repo/ref/path.
2. Recursively read the target directory via the GitHub Contents API.
3. Require a `SKILL.md` to exist in the directory.
4. Extract `name`, `description`, `author` from the `SKILL.md` frontmatter.
5. Store `SKILL.md` in `Skill.content`.
6. Store other text files under safe paths in `Skill.files`.

Safety limits:

1. Import never executes repo scripts, `npm install`, `npx`, or `uvx`.
2. Per-file size, total bundle size, and file count are all capped.
3. Absolute paths, empty paths, traversal, `.git`, and `node_modules` are rejected.
4. Paths are validated again when syncing to clients, so even corrupt server data cannot write outside the skill directory.

So a repo like the Anthropic PDF skill containing `scripts/` can be imported as a bundle, and its scripts sync verbatim with the skill into the Claude Code, Codex, opencode cache, or Hermes skills directory. Capabilities that need `npx` should be written as `SKILL.md` instructions or built as an MCP server's `installCommand`/deployment config; the market import itself only stores and distributes skill files — it does not run remote package installs.

---

## 6. Claude Code Auto-Sync

Claude Code uses its local plugin mechanism.

File layout after install:

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

The install script runs:

```bash
claude plugin marketplace add "$PLUGIN_DIR"
claude plugin uninstall toolplane-<toolkit>@toolplane-<toolkit> || true
claude plugin install toolplane-<toolkit>@toolplane-<toolkit>
```

### MCP tools

`.mcp.json` looks like:

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

`hooks/hooks.json` registers a `SessionStart` hook:

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

On every Claude Code session start, `sync.sh` refreshes `skills/<slug>/SKILL.md` and that skill's companion files.

### Skill telemetry

Claude Code also registers:

```txt
PostToolUse
PostToolUseFailure
```

with matcher `Skill`, recording only Skill tool invocations. `skill-invocation.sh` reports skill slug, source, success/failure, and error type to:

```txt
POST /api/v1/plugin/skill-invocation
```

---

## 7. Codex Auto-Sync

Codex uses user-level MCP config + a user-level hook + user-level skills.

File layout after install:

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

The install script writes a marker-delimited block into `~/.codex/config.toml`:

```toml
# BEGIN TOOLPLANE toolplane-devtools
[mcp_servers.toolplane-devtools]
url = "https://app/api/v1/workspaces/ws/toolkits/devtools/mcp"
http_headers = { Authorization = "Bearer <token>" }
enabled = true
# END TOOLPLANE toolplane-devtools
```

Reinstalling the same toolkit deletes the old marker block before writing the new one, avoiding duplicate config.

### Skills

The install script writes a `SessionStart` hook into `~/.codex/hooks.json`:

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

`sync.sh` writes skills to:

```txt
~/.agents/skills/toolplane-<toolkit>-<skill-slug>/SKILL.md
```

If a skill has bundle companion files, they land in the same skill directory, e.g. `scripts/convert_pdf_to_images.py`. Codex discovers these skills from the user-level `~/.agents/skills`. Codex hooks require user trust: on first install or after the hook content changes, the user may need to open `/hooks` in Codex to review and trust.

Codex sync currently covers only:

1. MCP tools configuration.
2. Skills file sync.

Codex skill invocation telemetry is not implemented yet, because Codex's skill invocation event model differs from Claude Code's `Skill` tool hook.

---

## 8. opencode Auto-Sync

opencode currently supports remote MCP and custom commands but has no automatic skill discovery equivalent to Codex Agent Skills. So a compatibility sync is used:

1. MCP tools: native remote MCP.
2. Skills: synced into a local cache.
3. command: a generated toolkit command that points opencode at the local cache.

File layout after install:

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

If `OPENCODE_CONFIG` is set, config goes there; otherwise it goes to:

```txt
$OPENCODE_CONFIG_DIR/opencode.json
```

### MCP tools

The install script writes:

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

`sync.sh` writes skills to:

```txt
~/.config/opencode/toolplane/toolplane-<toolkit>/skills/<skill-slug>/SKILL.md
```

Bundle companion files land in the same cache directory.

The install script also maintains a command:

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

Usage:

```txt
/toolplane-<toolkit> <task>
```

This is explicit command triggering, not implicit skill auto-triggering. If opencode later supports open agent skills or fuller prompt/session hooks, this layer can be upgraded toward the Codex experience.

---

## 9. Hermes Auto-Sync

Hermes natively supports remote HTTP MCP and has local skills directories and skill bundles. So:

1. MCP tools: written into `mcp_servers` in `~/.hermes/config.yaml`.
2. Skills: synced under `~/.hermes/skills/toolplane-<toolkit>/`; directory names prefer the `name` from `SKILL.md` frontmatter to avoid long slugs in Hermes prompts.
3. Bundle: written to `~/.hermes/skill-bundles/toolplane-<toolkit>.yaml`, organizing this toolkit's synced skills into one Hermes bundle.
4. Hook: written to `hooks.on_session_start`, silently running the sync script when a new session starts.

File layout after install:

```txt
$HERMES_HOME or ~/.hermes/
├─ config.yaml
├─ skill-bundles/
│  └─ toolplane-<toolkit>.yaml
├─ skills/
│  └─ toolplane-<toolkit>/
│     └─ <skill-name>/
│        ├─ SKILL.md
│        └─ scripts/...
└─ toolplane/
   └─ toolplane-<toolkit>/
      ├─ .mcp.json
      └─ shared/
         ├─ hook-sync.sh
         └─ sync.sh
```

If `HERMES_CONFIG` is set, config goes there; otherwise:

```txt
$HERMES_HOME/config.yaml
```

If `HERMES_HOME` is unset, the default is:

```txt
~/.hermes/config.yaml
```

### MCP tools

The install script writes a marker block under `mcp_servers` in `config.yaml`:

```yaml
mcp_servers:
  # BEGIN TOOLPLANE toolplane-devtools
  toolplane-devtools:
    url: "https://app/api/v1/workspaces/ws/toolkits/devtools/mcp"
    headers:
      Authorization: "Bearer <token>"
  # END TOOLPLANE toolplane-devtools
```

Reinstalling the same toolkit deletes the old marker block before writing the new one, avoiding duplicate config.

### Skills and bundle

`sync.sh` writes skills to:

```txt
~/.hermes/skills/toolplane-<toolkit>/<skill-name>/SKILL.md
```

Directory names matter for Hermes skill lookup, but prompts display the `name` from `SKILL.md`. So the Hermes sync path reads the frontmatter `name` as the directory name, falling back to the baseline slug if it is missing or unsafe. Bundle companion files land in the same skill directory.

After syncing, the install script scans these directories and writes the bundle:

```yaml
name: toolplane-devtools
description: "ToolPlane toolkit devtools"
skills:
  - toolplane-devtools/pdf
  - toolplane-devtools/github
instruction: |
  Use the ToolPlane toolkit "devtools".
  Its MCP tools are available through the "toolplane-devtools" MCP server.
```

If the `hermes` CLI exists locally, the install script runs:

```bash
hermes bundles reload
```

### Auto-sync hook

The install script also writes a shell hook under the same marker block in `config.yaml`:

```yaml
hooks:
  on_session_start:
    # BEGIN TOOLPLANE toolplane-devtools
    - command: "bash ~/.hermes/toolplane/toolplane-devtools/shared/hook-sync.sh"
      timeout: 30
    # END TOOLPLANE toolplane-devtools
```

`hook-sync.sh`:

1. Discards the hook JSON payload Hermes passes in.
2. Silently runs `shared/sync.sh`.
3. Rewrites `skill-bundles/toolplane-<toolkit>.yaml` from the synced skill directories.
4. Deletes `.skills_prompt_snapshot.json` so the next prompt re-reads the latest skills index.
5. Outputs `{}`, satisfying the Hermes shell-hook stdout JSON protocol without injecting extra context.

The first time this hook runs, Hermes may ask the user to approve; `--accept-hooks` or `HERMES_ACCEPT_HOOKS=1` pre-approves. The install script still syncs once at install time and leaves a manual sync entry point:

```bash
~/.hermes/toolplane/toolplane-<toolkit>/shared/sync.sh
```

A running Hermes session needs manual reloads:

```txt
/reload-mcp
/reload-skills
```

---

## 10. Direct Connection vs Auto-Sync

The Toolkit install panel has two tabs:

| Tab | Purpose | Syncs skills? |
|---|---|---|
| Auto-sync | Returns a bash installer that writes local client config and sync scripts | Yes |
| Direct connection | Shows only manual MCP config snippets | No |

Direct connection is only for quickly attaching the toolkit to a client as a remote MCP server. It creates no install token and writes no local `SKILL.md`.

Auto-sync is the complete "tools + skills" sync path.

---

## 11. Uninstall Behavior

The uninstall script cleans up all four client types as best it can:

1. Claude Code:
   - `claude plugin uninstall`
   - `claude plugin marketplace remove`
   - delete `~/.claude/plugins/toolplane-<toolkit>`

2. Codex:
   - remove the marker block from `config.toml`
   - remove the matching `sync.sh` hook from `hooks.json`
   - delete `~/.agents/skills/toolplane-<toolkit>-*`
   - delete `~/.codex/toolplane/toolplane-<toolkit>`

3. opencode:
   - remove `mcp[server]` from `opencode.json`
   - remove `command[server]`
   - delete the local cache bundle

4. Hermes:
   - remove the marker block from `config.yaml`
   - delete `~/.hermes/skills/toolplane/toolplane-<toolkit>-*`
   - delete `~/.hermes/skill-bundles/toolplane-<toolkit>.yaml`
   - delete `~/.hermes/toolplane/toolplane-<toolkit>`

The server simultaneously revokes every install token under this toolkit.

---

## 12. Security Boundaries

These constraints must hold:

1. An install link stores only an opaque id — never a plaintext token.
2. The plaintext token appears exactly once, in the install-script response.
3. Tokens are named and rotated independently per toolkit + client.
4. The baseline API must verify the token's user belongs to the workspace.
5. The MCP gateway must verify the toolkit belongs to the caller's workspace.
6. `sync.sh` must validate skill slugs and bundle file paths against path traversal.
7. Uninstall should revoke all install tokens under the toolkit.
8. Local config merging must stay minimal: Codex and Hermes use marker blocks; opencode overwrites only the matching `mcp[server]` and `command[server]`.

---

## 13. Test Coverage

Related tests:

| Test | Coverage |
|---|---|
| `tests/unit/plugin-install-script.test.ts` | client parsing, script content, Codex/opencode/Hermes dispatch |
| `tests/unit/plugin-install-flow.test.ts` | actually executes the generated bash installer and verifies local files land |
| `tests/unit/plugin-direct-config.test.ts` | Direct-connection config snippets |
| `tests/unit/plugin-telemetry-scripts.test.ts` | sync and skill-invocation shell script content |
| `tests/unit/skill-bundle.test.ts` | GitHub skill bundle URL parsing, frontmatter, path safety, recursive import |
| `tests/integration/toolkit-install-link.test.ts` | opaque install links, token rotation, per-client tokens |
| `tests/integration/plugin-baseline.test.ts` | baseline permissions, content filtering, bundle file return |
| `tests/integration/plugin-telemetry.test.ts` | sync/skill telemetry APIs |

Recommended verification:

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

## 14. Future Improvements

1. `sync.sh` could use the baseline `version` to skip unchanged `SKILL.md` writes.
2. Codex could move to local plugin distribution, though `config.toml + hooks.json + ~/.agents/skills` is currently more direct and testable.
3. If opencode adds open agent skills, upgrade from the command/cache model to native skills.
4. Add `--dry-run` to the install script, showing which files would be written.
5. Show "last sync time / failure reason" in the UI by reading `SyncEvent`.
