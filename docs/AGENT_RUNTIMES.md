# Agent Runtime Implementation: Pi, Claude Code, and DSH

> **中文**：[AGENT_RUNTIMES.zh-CN.md](./AGENT_RUNTIMES.zh-CN.md)

This guide is for developers maintaining ToolPlane, integrating another runtime, or diagnosing Agent execution. It explains the actual execution paths, configuration, native sessions, and security boundaries of Pi, Claude Code (CC), and DeepSeek Harness (DSH). It covers **Agents executed inside ToolPlane sandboxes**, not Toolkit installation into a user's desktop clients; see [Toolkit Sync](./TOOLKIT_SYNC.en.md) for the latter.

Reviewed against `35c308e83e75228f1b42e7660ceefdc1e459d04f` on 2026-09-17. Linked source files, rather than copied version tables, define package versions and allowed capabilities. A runtime's product name does not imply that ToolPlane exposes every upstream CLI feature. See [Architecture](./ARCHITECTURE.en.md) for the system overview and [Hermes Runtime](./HERMES_AGENT_RUNTIME.en.md) for the separate Hermes implementation.

For the independent Hermes RPC sandbox adapter, see [Hermes RPC](./HERMES_RPC_RUNTIME.md); this guide still describes Pi, Claude Code and DSH.

## 1. Distinguish the four concepts

An **Agent** is workspace-scoped configuration and resource relationships. The **runtime kind** selects the execution adapter. A **Sandbox** supplies processes, a filesystem, and networking. A **Conversation** stores platform messages and can provide the native session lookup key. Native session reuse also depends on whether the caller supplies `runtimeSessionId`; a Conversation database record alone does not enable it.

[`runtime-kind.ts`](../src/lib/agents/runtime-kind.ts) defines the public kinds, capabilities, and builtin tool groups:

| Capability | Pi | Claude Code | DSH |
|---|---|---|---|
| Persisted runtime kind | `pi` | `claude-code` | `dsh` |
| Model binding | One `providerId + model` | One `providerId + model` | One `providerId + model` |
| Execution environment | Exactly one network-enabled Docker sandbox | Same | Same |
| Console / Work execution | Supported | Supported | Supported |
| Control MCP `create_agent` | Supported | Not exposed | Not exposed |
| Hermes-specific attachment upload capability | Not supported | Not supported | Not supported |
| Publishing as a public Agent Endpoint | Not exposed | Not exposed | Not exposed |

All three accept the provider formats `openai`, `openai-responses`, and `anthropic`, but their adapter paths differ; see section 4. An attachment capability of false does not mean the Agent cannot read sandbox files: an existing file reference is different from the Hermes-specific upload interface.

`native.ts` is an internal platform model-loop helper, not a public `native` creation value. The Pi CLI, the platform's `pi-ai` library, and the frontend AI SDK UI message stream are separate layers. The root `package.json` version of `pi-ai` does not determine the Pi CLI version installed in a sandbox.

## 2. Shared execution path

```text
Console messages / messaging channels / Work / sub-agent invocation
  → entry-point authentication, workspace and conversation ownership checks
  → resolveAgentTools: collect selected MCP deployments, Toolkits, and Skills
  → runDedicatedSandboxTurn: model, unique sandbox, short-lived runtime grant
  → runSandboxAgentTurn: runtime checks, package and Skill preparation
  → runPi / runClaudeCode / runDsh
  → native CLI inside the sandbox; model and MCP callbacks to ToolPlane
  → parse native events into text, tool activity, usage, and command catalogs
  → caller owns UI streaming, Work state, and platform message persistence
```

Creation and update start in [`actions.ts`](../src/lib/agents/actions.ts) and [`mutations.ts`](../src/lib/agents/mutations.ts). Configuration transactions validate workspace ownership of the model and resources. A dedicated sandbox record can be created when none was selected. **Creating those records does not establish runtime readiness**: execution still checks the sandbox relationship, network, and effective running state.

[`runDedicatedSandboxTurn()`](../src/lib/agents/sandbox-turn.ts) requires a valid model and exactly one Docker sandbox in the Agent's workspace. It rejects `network=none` and a mismatching explicit `sandboxId`, deduplicates and filters running MCP deployments, issues a runtime token for that context, and calls the lower-level runner.

[`sandbox-runtime.ts`](../src/lib/agents/sandbox-runtime.ts) verifies the assignment and effective deployment state again, constrains the working directory to `/workspace`, excludes the sandbox's own MCP deployment, prepares packages and selected Skills, and dispatches by kind. Docker operations participate in runtime ownership and cancellation. An unavailable sandbox does not cause execution to fall back to the application host.

## 3. Source map

| Behavior to understand or change | Main entry points |
|---|---|
| Runtime kinds, capabilities, builtin tool groups | [`runtime-kind.ts`](../src/lib/agents/runtime-kind.ts) |
| Saved messages and channel calls | [`message-service.ts`](../src/lib/agents/message-service.ts) |
| Direct chat UI streaming | [`chat/route.ts`](../src/app/api/v1/agents/%5BagentId%5D/chat/route.ts), [`ui-stream.ts`](../src/lib/agents/ui-stream.ts) |
| Work scheduling, working directory, events, cancellation | [`work/coordinator.ts`](../src/lib/work/coordinator.ts) |
| Platform sub-agent delegation | [`run.ts`](../src/lib/agents/run.ts) |
| Execution context and Docker adapters | [`sandbox-turn.ts`](../src/lib/agents/sandbox-turn.ts), [`sandbox-runtime.ts`](../src/lib/agents/sandbox-runtime.ts) |
| Pi / CC native session processes | [`native-runtime-session.mjs`](../scripts/native-runtime-session.mjs) |
| DSH session and command plugin | [`dsh-runtime-driver.mjs`](../scripts/dsh-runtime-driver.mjs) |
| Runtime grants and current resource relationships | [`runtime-access.ts`](../src/lib/agents/runtime-access.ts), [`runtime-grant.ts`](../src/lib/agents/runtime-grant.ts) |
| Native commands and platform conversation operations | [`runtime-commands.ts`](../src/lib/agents/runtime-commands.ts), [`runtime-command-service.ts`](../src/lib/agents/runtime-command-service.ts), [`conversation-operations.ts`](../src/lib/agents/conversation-operations.ts) |

## 4. Model proxy and credential boundaries

The model base for these adapters is ToolPlane's `/api/v1/agent-runtime/model/{providerId}`, not an upstream URL combined with the real provider key. MCP callbacks use `/api/v1/agent-runtime/mcp/{deploymentId}/rpc`.

[`runtime-access.ts`](../src/lib/agents/runtime-access.ts) signs a token binding `workspaceId`, `agentId`, `sandboxId`, `providerId`, and an allowed deployment list. Turns currently issue a 55-minute lifetime; the verifier caps the maximum TTL at 60 minutes. This is a runtime grant, not a user API token or Toolkit installation token, and it is not bound to an individual model ID.

The [model proxy](../src/app/api/v1/agent-runtime/model/%5BproviderId%5D/%5B%5B...path%5D%5D/route.ts) and [MCP proxy](../src/app/api/v1/agent-runtime/mcp/%5BdeploymentId%5D/rpc/route.ts) validate the grant and current resource relationships. The model proxy strips client credentials, cookies, and related headers, then supplies upstream authentication from platform configuration. Do not place runtime tokens, real provider keys, or database credentials in user-visible output or diagnostic material.

| Native caller | Model protocol adaptation |
|---|---|
| Pi | `buildPiModelsConfig()` maps the provider format to `openai-completions`, `openai-responses`, or `anthropic-messages` |
| Claude Code | The CLI sends Anthropic-shaped requests. For a non-Anthropic provider, ToolPlane's [`anthropic-gateway.ts`](../src/lib/agents/anthropic-gateway.ts) adapts `/v1/messages` and `/v1/messages/count_tokens` |
| DSH | `buildDshPatch()` configures `llm-pi-ai`, the default provider/model, and the same protocol mapping |

The CC compatibility gateway is not a promise to implement every Anthropic API. Its supported subset is defined by the request schemas, event conversion, and tests. The compatibility `count_tokens` response is estimated rather than authoritative upstream billing data.

`sandboxRuntimeOrigin()` resolves the callback origin. For connectivity failures, check `TOOLPLANE_RUNTIME_ORIGIN` and actual container-to-platform reachability first; loopback hostnames are rewritten to `host.docker.internal`. The function returns the URL origin, discarding path prefixes. Adding a subpath to that setting does not configure prefixed callback routes.

## 5. Pi: explicit configuration, MCP extension, and RPC sessions

`runPi()` generates a dedicated `models.json`, uses `PI_CODING_AGENT_DIR` for Agent state, and authenticates to the model proxy with `TOOLPLANE_RUNTIME_TOKEN`. It disables automatic discovery of default extensions, skills, prompt templates, themes, and context files, then explicitly loads the selected Skill directory and ToolPlane MCP extension.

- With `runtimeSessionId`, it uses `--mode rpc` and the native session driver to retain the CLI. Without it, it uses `--mode json --no-session` with the current transcript.
- `piMcpExtensionSource()` generates the explicitly loaded `--extension` bridge. It discovers MCP tools, registers names, calls JSON-RPC, and limits request, response, schema sizes, and the number of registered tools.
- Builtin tool exclusions are validated by `normalizeDisabledBuiltinTools()` and passed through `--exclude-tools`. This is separate from remote MCP authorization.
- `parsePiStreamLine()` extracts text, reasoning activity, tool calls, errors, and context usage. The session driver translates native `/compact [focus]` into Pi's `compact` RPC.

[`native-runtime-session.mjs`](../scripts/native-runtime-session.mjs) uses Pi's `SessionManager` for the first history import. The CLI owns subsequent JSONL session writes; the complete platform history is not imported again after native compaction. `--offline` / `PI_OFFLINE` does not make the integration air-gapped: initial package installation and model/MCP proxy requests still require reachable network paths.

## 6. Claude Code: stream-json, Skill plugin, and resume

`runClaudeCode()` uses `buildClaudeRuntimeArgs()` for flags including `--bare --print --verbose --output-format stream-json`. Persistent sessions also use `--input-format stream-json`; non-session execution uses `--no-session-persistence`. The system prompt is supplied with `--append-system-prompt`, and selected Skills with an explicit `--plugin-dir`.

`buildClaudeMcpConfig()` generates the MCP configuration. When selected MCP servers exist, the runner passes it with `--mcp-config` and `--strict-mcp-config`. Its authentication header contains the short-lived runtime token, not a real model key. In this adapter, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` also carry the runtime token; `ANTHROPIC_BASE_URL` points to ToolPlane's proxy.

The CLI runs as `CLAUDE_RUNTIME_USER`, currently `1000:1000`. Preparation recursively changes ownership under `/workspace`, so this is not a side-effect-free script for arbitrary host mounts. `HOME` and `CLAUDE_CONFIG_DIR` point to the Agent's separate state directory.

Persistent execution uses the same socket driver as Pi, but a different protocol: CC stream-json input/output, `--session-id` for a new session, and `--resume` for an existing one. The one-time legacy-history import depends on the pinned CLI's resume-file format. Verify that format when upgrading rather than assuming compatibility across versions.

`parseClaudeRuntimeMetadata()` reads the live command catalog from `system/init` and `commands_changed`, and usage from `result`. `parseClaudeStreamLine()` handles partial messages, text, tools, and errors. `/clear`, `/compact [focus]`, `/context`, and `/usage` are executed by the native CLI rather than simulated by same-named host operations.

## 7. DSH: headless profile, plugin driver, and durable state

`runDsh()` prepares a patch, input file, and randomly prefixed event plugin for each execution, then invokes `dsh --profile headless --patch ...`. `buildDshPatch()` configures the model, system prompt, Skill roots, and streamable-http connections through `@deepseek-ai/dsh-mcp-client`.

With `runtimeSessionId`, the patch disables the default `headless-runner` and loads [`dsh-runtime-driver.mjs`](../scripts/dsh-runtime-driver.mjs). The driver waits for dependencies, looks up `toolplane-<runtimeSessionId>`, and calls `agents.resume()` or `agents.create()`. History is imported only for a new session. It then executes a registered command or sends a followup, waits for idle, checks successful `turn/end` completion, and flushes the session in `finally`.

**This is not Pi/CC's socket-based CLI process retained between turns.** The native DSH process can exit; the next execution restores its session and goal from persisted data under `DSH_HOME`. Without a session ID, the ordinary headless path remains in use.

The event plugin writes JSON lines with a per-execution random prefix. `parseDshEventLine()` parses matching activity events; command catalogs and command results use the same prefixed channel. Context usage from this adapter is currently estimated, not precise billing data.

DSH builtin exclusions map to plugin rows. For example, several filesystem tools share `tool-fs`, so disabling one mapped tool can disable that plugin group. UI and policy changes must reflect this granularity rather than promise per-tool isolation. `/goal` and its arguments are interpreted by DSH's native command registry.

## 8. Session reuse depends on the entry point

These are the caller arguments at the reviewed baseline, not an assumption about every future entry point:

| Caller | `runtimeSessionId` supplied to the dedicated runner | Behavior |
|---|---|---|
| `message-service.ts` | `conversation.id` | Uses the corresponding native session |
| `work/coordinator.ts` | `work.conversationId` | Uses the native session and passes the Work working directory |
| Ordinary conversation commands in `runtime-command-service.ts` | `conversation.id` | Runs against that native session; Work commands are queued for the coordinator |
| Dedicated branch of `agents/[agentId]/chat/route.ts` | Not supplied | Uses execution without an explicit native session ID |
| Dedicated sub-agent branch of `run.ts` | Not supplied | One-shot delegation; does not reuse the parent's native conversation |

Platform messages, Hermes runtime-session fields, and these native session keys are not interchangeable. In particular, persistence of platform messages through direct `/chat` does not establish that later native commands and chat share one CLI state.

The Pi/CC driver hashes `statePath` into a sandbox-local Unix socket. Each socket accepts one active request. A changed configuration signature or an aged process causes restart-and-resume on the next request; idle processes also exit. Driver state is written through a temporary file and rename. Missing native history after an earlier import is an error: replaying the entire platform history would mask the loss and could undo prior compaction semantics.

[`runtime-commands.ts`](../src/lib/agents/runtime-commands.ts) supplies a small fallback catalog and only merges live catalogs for CC/DSH from the current runtime/session. Host commands such as `new` and `help` are excluded. The [command service](../src/lib/agents/runtime-command-service.ts) checks workspace, Agent, Conversation, runtime changes, and busy state. An unknown command is not silently converted into a normal model prompt.

## 9. Package, Skill, and MCP file layout

This is a conceptual layout; exact filenames are generated by the runner. Do not copy entire credential-bearing files into issues or logs.

```text
/workspace/.toolplane/
  runtime-packages/<runtime-and-version>/  # pinned CLI and dependencies
  npm-cache/pnpm-store/                    # installation cache
  runtime-tmp/                            # per-turn or session bridge config/input
  runtimes/<kind>/agents/<agentId>/        # Agent state root
    skills/                               # selected Skill root for Pi/DSH
    sessions/                             # Pi/CC driver state; other data is CLI-owned
```

For CC, the Skill root is itself a plugin directory containing `.claude-plugin/plugin.json` and `skills/<skill>/SKILL.md`, hence the additional `skills/` level. `materializeSandboxSkills()` skips unchanged content using a digest, or rebuilds Markdown and additional files. It is not the recoverable desktop Toolkit transaction in `plugin/sync-client.ts`; do not transfer recovery guarantees between these implementations.

[`SANDBOX_RUNTIME_PACKAGES`](../src/lib/agents/sandbox-runtime.ts) defines versions, installation directories, and binaries. `ensureRuntimeInstalled()` checks the executable inside the target container, installs pinned packages with `pnpm add` and controlled build-script permissions, and shares concurrent installation waits within the same application process. The sandbox image must provide the required Node, pnpm, and system facilities. Updating root project dependencies does not automatically upgrade the CLI already installed in a sandbox.

Selected Skills come from platform resource resolution, and extra-file paths are checked. Each CLI consumes them through its own file/execution tools. Host tools, knowledge-base tools, and platform sub-agent wrappers from `buildAgentToolSet()` are not automatically injected merely by creating a dedicated runner. Native CLI sub-agent features are also different from ToolPlane's Agent relationship graph.

Attachments become readable path hints only when they carry a valid sandbox `runtimePath`. Otherwise, the transcript states that bytes are not mounted. A file/image message part does not prove that the file exists inside that Docker sandbox.

## 10. Events, usage, and persistence ownership

The runner exposes `onTextDelta`, `onActivity`, `onContextUsage`, `onCommands`, and `onUsage`, but not every runtime supplies precise data for every callback. Tool activity is enriched with deployment and original-name mappings to distinguish native builtins from remote MCP tools.

[`ui-stream.ts`](../src/lib/agents/ui-stream.ts) maps activity into frontend text/reasoning/tool chunks. The Work coordinator instead publishes Work output and persists its state. Command catalogs, command results, and runtime usage use the message parts defined in `runtime-commands.ts`. **A shared frontend stream format does not imply a shared execution engine or database-message persistence inside the low-level runner.**

Pi/CC use native statistics where available, with estimates on applicable fallback paths. DSH currently reports estimates. Compatibility-gateway estimates, estimated context-window sizes, and billing usage are separate concepts; displayed token counts alone do not establish a bill.

## 11. Security, cancellation, and troubleshooting

The CLIs execute noninteractively inside dedicated sandboxes: Pi uses `--no-approve`, CC uses `--dangerously-skip-permissions`, and DSH sets `DSH_PERMISSION_MODE=danger-full-access`. These describe the existing integration, not recommended host-machine launch commands. **Builtin exclusions and MCP scopes do not replace container, mount, and network isolation; do not assume every native builtin passes through a platform per-tool approval gate.**

`runTrackedDockerExec()` records the in-container PID, serializes output callbacks, and combines request cancellation with runtime-owner cancellation. Timeouts, cancellation, and excess output trigger attempts to terminate the in-container process tree and clean up Docker exec. This is bounded cleanup, not transactional rollback of arbitrary external effects. The Pi/CC driver also handles socket disconnection and native child exit. See [Runtime Operations](./RUNTIME_OPERATIONS.md) for single ownership, readiness, and manual recovery after an unclean exit; never bypass recovery markers to take over from an old instance that may still be active.

| Symptom | Check first |
|---|---|
| Exactly-one-sandbox or not-running error | AgentSandbox count, workspace ownership, Docker kind, network, effective deployment state |
| First execution fails | `SANDBOX_RUNTIME_PACKAGES`, container Node/pnpm, registry reachability, permitted install scripts, filesystem permissions |
| Model or MCP returns 401/403 | Token expiry, current provider/deployment grants, changed Agent/sandbox relationships; do not substitute a personal token |
| Native session busy or history missing | Actual caller session ID, working directory, native state directory, concurrent session activity; restore matching sandbox data or start a new conversation when appropriate |
| `/compact` / `/goal` unavailable or rejects arguments | Current runtime command catalog, persistent mode, native registry, CLI argument contract |
| Skill or file missing | Resource selection, plugin directory nesting, digest, actual mounted bytes rather than only a platform attachment record |
| HTTP responds but execution is blocked | Runtime readiness and single-owner status; process liveness is not completed runtime recovery |

See [Observability](./OBSERVABILITY.md) for capture policy. Start with correlation IDs, status, duration, and failure types. Agent-content capture requires explicit, time-limited authorization; do not paste complete native stdout, prompts, or private configuration into public issues.

## 12. Verification and evolution constraints

Focused regression entry points that do not require a real CLI:

```bash
pnpm vitest run tests/unit/agent-sandbox-runtime.test.ts tests/unit/agent-sandbox-turn.test.ts
pnpm vitest run tests/unit/agent-runtime-access.test.ts tests/unit/agent-runtime-proxy.test.ts tests/unit/agent-anthropic-gateway.test.ts
pnpm vitest run tests/unit/documentation-contracts.test.ts
```

Real native-session tests are opt-in. They require a disposable container with the matching pinned runtime already installed and network reachability from that container to the test process. Do not point them at a production Agent sandbox. The container name below is an example; the tests do not create or prepare it.

```bash
TOOLPLANE_NATIVE_COMMAND_SANDBOX=toolplane-runtime-test \
TOOLPLANE_NATIVE_COMMAND_KIND=pi \
  pnpm vitest run tests/integration/native-runtime-session.test.ts

TOOLPLANE_COMMAND_SANDBOX_TEST=toolplane-runtime-test \
  pnpm vitest run tests/integration/dsh-command-driver.test.ts
```

The first command also accepts `claude-code` or `dsh` as the kind. See the [native-session test](../tests/integration/native-runtime-session.test.ts) and [DSH command test](../tests/integration/dsh-command-driver.test.ts). They skip when their environment variables are absent; ordinary CI success does not establish real CLI session validation.

A runtime upgrade or new adapter should review the capability registry, package definitions, provider mappings, event parsers, Skill/MCP projection, first-history import and resume, native commands, and cancellation in the same PR. Add focused tests and update both language versions. Do not force three different native session protocols into one implementation merely to unify their appearance.
