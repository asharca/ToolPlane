# Toolkit Sync Mechanism

> **中文**：[TOOLKIT_SYNC.md](./TOOLKIT_SYNC.md)
>
> This document explains how Toolkits sync to Claude Code, Codex, opencode, and Hermes: MCP tools, Skills, install tokens, client-side local files, and test coverage.

Installation paths below use `<installation>` for the stable `toolplane-<24 hex characters>` identifier. It hashes the normalized service URL (including its base path), workspace ID, and Toolkit ID; display names are not identities. `toolplane-0123456789abcdef01234567` is illustrative, not the hash of the example URL. Existing slug-only installations are preserved; register the new installation, verify it, and explicitly revoke/remove the legacy one.

---

## 1. Sync Targets

A Toolkit is a freely assembled set of resources in a workspace:

1. `ToolkitServer`: points to a deployed MCP server, i.e. a `Deployment`.
2. `ToolkitSkill`: points to an `InstalledSkill` in the workspace.

Syncing to a local client happens over two channels:

| Channel | What syncs | How |
|---|---|---|
| MCP tools | All tools exposed by the toolkit's running deployments | The client configures one remote MCP endpoint; the server aggregates dynamically at `tools/list` |
| Skills | The toolkit's explicitly bound skills (including draft) | A local install script pulls the baseline and writes each skill as a skill directory containing `SKILL.md` plus bundle files |

MCP tools are not written into local files. The client only needs one remote MCP URL:

```txt
/api/v1/workspaces/:workspace/toolkits/:toolkit/mcp
```

This endpoint reads the toolkit's bound deployments at runtime and aggregates the tools of every running MCP child process via `listMcpTools()`.

Skills are different. Claude Code and Codex both have local skill directory/plugin mechanisms, so the remote baseline must be synced into file directories. The current ToolPlane opencode adapter uses "remote MCP + command + local skill cache"; this is a description of this adapter, not a claim that every opencode version lacks native skills.

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

## 3. Installation Identity and Credentials

The opaque `/install/:id?client=<client>` link is a credential-issuing capability: keep it private. `GET` returns a tokenless bootstrap; previewing the link does not create or rotate credentials. Executing the bootstrap makes a bounded JSON `POST` to `/install/:id`.

A new device/client registration gets its own `ToolkitInstallation` and scoped API token. Reinstalling uses private `installation.json` plus `.mcp.json` to prove ownership of that registration. Knowing an installation ID alone cannot rotate or revoke it. Tokens are hashed in the database; generated scripts and client configuration necessarily contain the credential and are written with private permissions.

The server rechecks the user, active workspace, membership, enabled Toolkit, link validity, client, and installation under a workspace row lock. Rotation and auditing are transactional. Previous current credentials get at most five minutes of grace; an earlier grace period is never extended, and each registration retains at most three keys. There are at most 100 active registrations per user/Toolkit. Separate devices do not rotate one another's keys.

The Toolkit install panel lists registrations and supports revoking one, revoking all of the current user's registrations for this Toolkit, and regenerating the install link. Regenerating the link invalidates the old registration capability without revoking already installed credentials. Member removal and Toolkit deletion still revoke the corresponding access.

The bootstrap serializes local configuration updates with a per-client lock. It records a private `pending-install.sh` before applying configuration; retrying resumes that file first. Never share it: it contains a credential. A stale installer lock requires confirming the previous process is stopped before removing the lock. A lost initial registration response can leave an unused registration; inspect/revoke it in the panel and register again. This flow does not promise exactly-once registration across a lost response.

Legacy slug-only installations are not guessed or automatically deleted. For same-type clients on separate computers, each computer registers independently; copying a credential/state directory to another machine intentionally shares the registration, not a new device identity.

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

1. Verifies the user can access an active workspace and enabled Toolkit, and intersects the requested Toolkit with the credential's `toolkitId` when the token is scoped.
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

## 5. Validated, Recoverable Skill Sync

```text
GET /api/v1/plugin/baseline?workspace=<workspace>&toolkit=<toolkit>
Authorization: Bearer <install-token>
```

The baseline is a complete, versioned snapshot. Example:

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

`version` is the first 12 hexadecimal characters of SHA-256 over `JSON.stringify({ content, files })`. The client checks it and records the full digest locally. File entries contain `path`, `content`, and optional `encoding: "base64"`; `SKILL.md` is represented by `content`, not duplicated in `files`.

Baseline export includes every explicitly bound skill, including `draft`. It does not filter by `userInvocable` or `agentInvocable`; the artifact builder carries supported invocation metadata into SKILL.md. This is distinct from platform Agent resolution, which applies its own `agentInvocable` selection. Export is authorized distribution, not execution approval.

`sync.sh` downloads into a private bounded temporary file; bundles never travel in process environment variables. `sync-client.ts` validates schema/version, full-snapshot marker, workspace/Toolkit identity, unique skill names, file paths, encodings and hashes before touching the active version. Missing `data.skills` is an error, not an empty Toolkit. A valid empty snapshot can remove only this installation's owned skills.

The client limits a response and aggregate content to 32 MiB, an individual file to 8 MiB, the snapshot to 1,000 skills and 20,000 files. It rejects traversal, absolute/reserved paths, duplicate/conflicting names and symlinked managed locations.

A per-installation process lock serializes sync. New content is staged on the same filesystem; a recovery journal and backups protect the commit. The manifest generation is the commit point. A killed or failed update recovers on the next run before accepting another snapshot. This is recoverable multi-directory update, not a claim that readers see an atomic switch across every client directory.

The manifest at `<skills-root>/.toolplane-state/<installation>/manifest.json` records exact owned directories, applied hashes and last-success time. `last-attempt.json` records failure/success status. Unchanged hashes are skipped. Cleanup never relies on a potentially overlapping Toolkit-name prefix and never overwrites an unowned directory. Hooks may allow chat to continue on sync failure; a zero exit from the outer hook is not proof of a successful refresh.

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

The install script runs:

```bash
claude plugin marketplace add "$PLUGIN_DIR"
claude plugin uninstall <installation>@<installation> || true
claude plugin install <installation>@<installation>
```

### MCP tools

`.mcp.json` looks like:

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

The install script writes a marker-delimited block into `~/.codex/config.toml`:

```toml
# BEGIN TOOLPLANE toolplane-0123456789abcdef01234567
[mcp_servers.toolplane-0123456789abcdef01234567]
url = "https://app/api/v1/workspaces/ws/toolkits/devtools/mcp"
http_headers = { Authorization = "Bearer <token>" }
enabled = true
# END TOOLPLANE toolplane-0123456789abcdef01234567
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

`sync.sh` writes skills to:

```txt
~/.agents/skills/<installation>-<skill-slug>/SKILL.md
```

If a skill has bundle companion files, they land in the same skill directory, e.g. `scripts/convert_pdf_to_images.py`. Codex discovers these skills from the user-level `~/.agents/skills`. Codex hooks require user trust: on first install or after the hook content changes, the user may need to open `/hooks` in Codex to review and trust.

Codex sync currently covers only:

1. MCP tools configuration.
2. Skills file sync.

Codex skill invocation telemetry is not implemented yet, because Codex's skill invocation event model differs from Claude Code's `Skill` tool hook.

---

## 8. opencode Auto-Sync

The current ToolPlane opencode adapter uses this compatibility sync:

1. MCP tools: native remote MCP.
2. Skills: synced into a local cache.
3. command: a generated toolkit command that points opencode at the local cache.

File layout after install:

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

`sync.sh` writes skills to:

```txt
~/.config/opencode/toolplane/<installation>/skills/<skill-slug>/SKILL.md
```

Bundle companion files land in the same cache directory.

The install script also maintains a command:

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

Usage:

```txt
/<installation> <task>
```

This is explicit command triggering, not implicit skill auto-triggering. If opencode later supports open agent skills or fuller prompt/session hooks, this layer can be upgraded toward the Codex experience.

---

## 9. Hermes Auto-Sync

Hermes natively supports remote HTTP MCP and has local skills directories and skill bundles. So:

1. MCP tools: written into `mcp_servers` in `~/.hermes/config.yaml`.
2. Skills: synced under `~/.hermes/skills/<installation>/`; directory names prefer the `name` from `SKILL.md` frontmatter to avoid long slugs in Hermes prompts.
3. Bundle: written to `~/.hermes/skill-bundles/<installation>.yaml`, organizing this toolkit's synced skills into one Hermes bundle.
4. Hook: written to `hooks.on_session_start`, silently running the sync script when a new session starts.

File layout after install:

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
  # BEGIN TOOLPLANE toolplane-0123456789abcdef01234567
  toolplane-0123456789abcdef01234567:
    url: "https://app/api/v1/workspaces/ws/toolkits/devtools/mcp"
    headers:
      Authorization: "Bearer <token>"
  # END TOOLPLANE toolplane-0123456789abcdef01234567
```

Reinstalling the same toolkit deletes the old marker block before writing the new one, avoiding duplicate config.

### Skills and bundle

`sync.sh` writes skills to:

```txt
~/.hermes/skills/<installation>/<skill-name>/SKILL.md
```

Directory names matter for Hermes skill lookup, but prompts display the `name` from `SKILL.md`. So the Hermes sync path reads the frontmatter `name` as the directory name, falling back to the baseline slug if it is missing or unsafe. Bundle companion files land in the same skill directory.

After syncing, the install script scans these directories and writes the bundle:

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

If the `hermes` CLI exists locally, the install script runs:

```bash
hermes bundles reload
```

### Auto-sync hook

The install script also writes a shell hook under the same marker block in `config.yaml`:

```yaml
hooks:
  on_session_start:
    # BEGIN TOOLPLANE toolplane-0123456789abcdef01234567
    - command: "bash $HOME/.hermes/toolplane/toolplane-0123456789abcdef01234567/shared/hook-sync.sh"
      timeout: 30
    # END TOOLPLANE toolplane-0123456789abcdef01234567
```

`hook-sync.sh`:

1. Discards the hook JSON payload Hermes passes in.
2. Silently runs `shared/sync.sh`.
3. Rewrites `skill-bundles/<installation>.yaml` from the committed ownership manifest, excluding state folders and neighboring manual skills.
4. Deletes `.skills_prompt_snapshot.json` so the next prompt re-reads the latest skills index.
5. Outputs `{}`, satisfying the Hermes shell-hook stdout JSON protocol without injecting extra context.

The first time this hook runs, Hermes may ask the user to approve; `--accept-hooks` or `HERMES_ACCEPT_HOOKS=1` pre-approves. The install script still syncs once at install time and leaves a manual sync entry point:

```bash
~/.hermes/toolplane/<installation>/shared/sync.sh
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

`GET /install/:id/uninstall?client=<client>` returns a tokenless bootstrap and does not revoke credentials. Running it proves the current registration's credential, revokes only that installation, and applies client-specific cleanup. Revocation retries are idempotent; revoking every installation is a separate panel action.

Cleanup removes the exact managed MCP configuration block/key, that sync hook, installer-owned files and manifest-owned skills for the selected client. Other clients, other installations, neighboring manual skills and user-created files are preserved. Empty managed directories can be removed; nonempty directories are retained. Corrupt manifests, symlinked state and pending sync recovery cause cleanup to stop rather than guess ownership.

Legacy installation directories have no proven new ownership and are deliberately retained. Reconcile or remove them explicitly after verifying the new registration. A server revocation does not claim it erased cached files from an offline device.

---

## 12. Security Boundaries

- A personal token and a Toolkit installation token are different principals. Toolkit endpoints preserve the scope; account and Agent Control APIs reject Toolkit tokens. An explicit invalid Bearer token never falls back to a browser cookie.
- Install links are capabilities even though their rows contain no plaintext API token. Regenerate leaked links, inspect registrations, and revoke affected tokens separately.
- All credential rotations/revocations remain bound to the user, Toolkit, client and installation. A self-reported device label is display metadata, not authorization.
- Local configuration parsing fails closed on invalid JSON or unsupported YAML instead of replacing unrelated configuration. Configuration markers must be balanced. Existing files outside manifest ownership are not removed.
- Download/hash/path checks protect update integrity but do not make arbitrary Skill instructions or scripts trustworthy. Client-side execution still needs the client's own permissions and trust controls.

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
| `tests/integration/toolkit-install-link.test.ts` | opaque install links, transactional rotation, per-installation tokens |
| `tests/integration/plugin-baseline.test.ts` | baseline permissions, content filtering, bundle file return |
| `tests/integration/plugin-telemetry.test.ts` | sync/skill telemetry APIs |

Additional regressions: `tests/unit/toolkit-principal.test.ts`, `tests/unit/toolkit-sync-transaction.test.ts`, and `tests/unit/documentation-contracts.test.ts`.

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

## 14. Remaining Extensions

Potential follow-ups include a dry-run installer, explicit guided legacy migration, and richer UI presentation of local last-success/failure state. Native client integrations may evolve independently; test their actual versions before changing adapters. Current sync already skips unchanged hashes and stores local recovery/status metadata.

---
