# Agent Runtime Implementation: Native Pi SDK

> **中文**：[AGENT_RUNTIMES.zh-CN.md](./AGENT_RUNTIMES.zh-CN.md)

This guide describes ToolPlane's executable Agent architecture: **Pi SDK 0.87.1**, using the official `AgentSession` runtime inside a dedicated Docker sandbox. It is not a desktop Toolkit installation guide; see [Toolkit Sync](./TOOLKIT_SYNC.en.md). Operational ownership, recovery and controlled cutover procedures are in [Runtime Operations](./RUNTIME_OPERATIONS.md).

There is one executable path. Ordinary Pi CLI, Claude Code, DSH, Hermes and the former Harness are not alternative executors or recovery fallbacks. Historical non-Pi messages and bound files remain read-only; only cancellation/drain of genuinely already-bound operations remains available. Conversion creates a fresh Pi draft requiring explicit authorization, not a resumed legacy session.

## 1. Configuration is not execution authorization

An **Agent** owns workspace-scoped configuration and resource relationships. Its editable **draft** is distinct from its immutable applied **revision**. A **Conversation**, Work admission or local A2A context pins a revision; its **session sandbox** supplies an independent persistent filesystem and native process state.

The product creates Pi Agents; the internal executable runtime kind is `pi-sdk`. There is no second SDK selector or CLI mode to choose. Creating an Agent or sandbox record does not establish runtime readiness or authorize execution.

### Save draft → Prepare → Review → Apply

1. **Save draft** changes editable configuration only. It changes neither the published default nor existing sessions.
2. **Prepare** captures/builds dependencies and performs native capability preflight outside the publication transaction. The prepared configuration freezes the digest-pinned environment image, Pi version, network/resource limits, optional checksum-verified initial snapshot, credential references, model/instructions, Skill/package artifacts, and MCP/A2A grants. Credential plaintext is not configuration data.
3. **Review** the exact prepared configuration and capability/permission changes. **Apply** supplies the expected current revision ID. Publication revalidates live authority, artifacts, source digests and native preflight, then atomically compares and switches the default revision (CAS). Stale expectations or failed validation leave the old default untouched; prepare and review again.
4. **Rollback** publishes a new version from a retained revision of the same Agent, with the same expected-current-revision check and live validation. It does not rewrite history, restore revoked grants or move existing session pins.

See [`revisions.ts`](../src/lib/agents/revisions.ts) and [`revision-types.ts`](../src/lib/agents/revision-types.ts). Installing a package in a workspace does not activate it for an Agent. Resource Enable and guided installation publish only their explicitly reviewed changes over the applied revision, not unrelated draft edits. Uninstall publishes a CAS-protected removal-only default while retaining session-referenced artifacts and shared MCP deployments.

## 2. Fixed execution path

```text
Chat / channels / Work / local A2A
  → authenticated workspace, Agent and session admission
  → resolve the pinned immutable revision ∩ current live authority
  → acquire session/sandbox leases and enforce concurrency limits
  → obtain the session's independent persistent sandbox
  → sandbox-turn.ts / sandbox-runtime.ts
  → native-runtime-session.mjs daemon
  → pi-sdk-session.mjs: official Pi SDK 0.87.1 AgentSession
  → controlled model / approval / MCP / collaboration brokers
  → native events and completion receipts
  → caller-owned UI streaming, Work state and platform message persistence
```

The SDK requires Linux and Node 24; native package architecture must match the Docker daemon. Trusted runtime installation and frozen extension materialization are different operations: reviewed extension dependencies are not fetched or installed at turn time. Do not upgrade an active sandbox by installing a newer upstream Pi or editing version files.

An unavailable sandbox, invalid pin, denied broker or failed native load stops execution. It never selects a host model loop, ordinary CLI, another runtime, current mutable defaults or a replay of historical messages.

## 3. Source map

| Responsibility | Source |
|---|---|
| Runtime capability classification | [`runtime-kind.ts`](../src/lib/agents/runtime-kind.ts) |
| Immutable preparation, publication and live intersection | [`revisions.ts`](../src/lib/agents/revisions.ts) |
| Session sandbox allocation and retained bindings | [`conversation-sandbox.ts`](../src/lib/agents/conversation-sandbox.ts) |
| Dedicated turn and Docker execution | [`sandbox-turn.ts`](../src/lib/agents/sandbox-turn.ts), [`sandbox-runtime.ts`](../src/lib/agents/sandbox-runtime.ts) |
| Persistent daemon and SDK host | [`native-runtime-session.mjs`](../scripts/native-runtime-session.mjs), [`pi-sdk-session.mjs`](../scripts/pi-sdk-session.mjs) |
| Native capability preflight and namespaces | [`pi-sdk-preflight.mjs`](../scripts/pi-sdk-preflight.mjs), [`pi-sdk-capabilities.mjs`](../scripts/pi-sdk-capabilities.mjs) |
| Snapshot byte/link verification | [`pi-sdk-package-files.mjs`](../scripts/pi-sdk-package-files.mjs) |
| Exact package session pins | [`pi-session-packages.ts`](../src/lib/agents/pi-session-packages.ts) |
| Runtime grants | [`runtime-access.ts`](../src/lib/agents/runtime-access.ts), [`runtime-grant.ts`](../src/lib/agents/runtime-grant.ts) |
| Native tool approval hook | [`native-tool-approval.ts`](../src/lib/agents/native-tool-approval.ts) |
| Commands and conversation operations | [`runtime-commands.ts`](../src/lib/agents/runtime-commands.ts), [`runtime-command-service.ts`](../src/lib/agents/runtime-command-service.ts), [`conversation-operations.ts`](../src/lib/agents/conversation-operations.ts) |
| Message, Work and A2A callers | [`message-service.ts`](../src/lib/agents/message-service.ts), [`work/coordinator.ts`](../src/lib/work/coordinator.ts), [`local-executor.ts`](../src/lib/a2a/local-executor.ts) |
| UI projection | [`ui-stream.ts`](../src/lib/agents/ui-stream.ts) |

Retained historical event parsers are for interpreting stored data, not evidence of executable legacy adapters.

## 4. Session pins and independent volumes

New Conversations, Work and local A2A contexts persist `agentRevisionId`; Work pins at admission before volume allocation. Each session lazily receives a persistent sandbox from its pinned environment, not the Agent's current mutable template. Concurrent conversations do not share a writable sandbox, and session files are never automatically merged back into the template. Turns within one session remain serialized; Agent/platform concurrency limits and native/session-MCP leases still apply.

`PiSessionPackageSet` records exact package releases/checksums and MCP bindings. Workspace package updates, newly applied defaults and rollback affect new sessions only. Ordinary uninstall or listing withdrawal retains referenced approved artifacts; dangerous-release revocation and current provider, credential, package, MCP and directional collaboration restrictions still deny execution. A pin is not a snapshot of irrevocable permission.

The database owns identity, revision/sandbox bindings, authorization and task receipts. Official SDK JSONL files own native conversation state. State lives under `/workspace/.toolplane/runtimes/pi-sdk/agents/<agent-id>/`; local A2A reuses its persisted context ID. The private host state tracks the actual SDK session selected by new/fork/switch operations, independently of former Harness checkpoints.

Retained contexts must reopen the existing native session. Missing persisted history, or loss of a host before its first session file exists, fails with `PI_SDK_SESSION_MISSING`. Unresolved historical revision/package bindings fail with `AGENT_REVISION_UNRESOLVED`; mismatched package sets fail with `PI_SDK_PACKAGE_SET_CHANGED`. Investigate or restore the matching volume. Never infer a pin from current defaults, rewrite checksums, replay messages or create an empty session and call it recovery.

## 5. Native daemon and request context

[`native-runtime-session.mjs`](../scripts/native-runtime-session.mjs) accepts only `pi-sdk`. It hashes the private state path into a sandbox-local Unix socket and permits one active request; another receives `PI_SDK_BUSY`. It retains the SDK child between turns and handles process shutdown, socket disconnection and configuration-signature changes. A daemon restart is not permission to replay an interrupted task.

[`pi-sdk-session.mjs`](../scripts/pi-sdk-session.mjs) loads the pinned SDK and constructs official session services with explicit resources. Automatic default extension, Skill, prompt, theme and context-file discovery is disabled. Model credentials are held in memory for the request; the host refreshes runtime token and MCP context on each request, checks approval readiness before session initialization/model execution, and clears request credentials afterward. Missing context fails with `PI_SDK_CONTEXT_REQUIRED`; changed native tool definitions or approval mode fail with `PI_SDK_TOOLSET_CHANGED` rather than silently mutating the retained session.

Structured events use a dedicated file descriptor. Extension stdout/stderr is not a trusted protocol channel and cannot manufacture broker results. The caller, not the low-level runner, owns database message persistence and UI/Work lifecycle.

## 6. Controlled brokers and isolation

Model calls use ToolPlane's credentialed model proxy at `/api/v1/agent-runtime/model/{providerId}`, not a real upstream key passed to extension configuration. Runtime grants are scoped credentials, not personal API or desktop installation tokens. Proxy authorization rechecks current resource relationships; upstream credentials remain platform-controlled. Never expose runtime tokens, provider keys or database credentials in prompts, logs or issue attachments.

Approval readiness accepts only `/api/v1/agent-runtime/sessions/approvals` for ordinary sessions or `/api/v1/agent-runtime/a2a/<task-id>/approvals` for delegated tasks. The helper requires runtime authentication, HTTP(S), no embedded credentials/query/fragment, no redirects and bounded responses. A readiness denial prevents execution. The native pre-execution tool hook must not be replaced by approval inferred from activity logs or bypassed after a broker failure.

MCP tools must remain within both the immutable revision grant and the current explicit tool allowlist. Session brokers validate pinned images/recipes and live grants, then lazily start isolated sidecars; a stopped shared deployment is not grounds to discard a valid pinned recipe or borrow the shared process. Collaboration similarly intersects pinned and live inbound/outbound permissions, explicit bounded target grants, workspace/actor scope and cycle/depth limits.

**Tool approval is not arbitrary-code isolation.** Approved extensions can directly use Node, files and networking inside the sandbox. Builtin exclusions and broker scopes do not replace container, mount and network boundaries. Attachment metadata likewise does not prove bytes are mounted: readable file hints require a valid sandbox `runtimePath`.

For callback connectivity, inspect `TOOLPLANE_RUNTIME_ORIGIN` and actual container-to-platform reachability. `sandboxRuntimeOrigin()` rewrites loopback hosts to `host.docker.internal` and uses the URL origin, not a configured subpath.

## 7. Native preflight, packages and commands

Prepare/publication uses the real SDK loader in the fixed isolated capture image `toolplane-pi-package-capture:0.87.1`, not source-text guesses about extension factories. Native namespace checks include tools, commands, Skills and prompts plus reserved generated MCP names. Conflicts preserve typed `PI_CAPABILITY_CONFLICT`; selected extension failures preserve `PI_EXTENSION_LOAD_FAILED` and bounded stage diagnostics. Do not silently drop a conflicting extension or substitute another version.

Frozen snapshots include dependencies. Full byte/link verification precedes execution and reload; tampering fails with `PI_PACKAGE_CHECKSUM_MISMATCH` before the turn runs. Native snapshots must match the execution platform/architecture. Startup does not install marketplace packages, execute package-manager hooks or discover arbitrary user configuration as a fallback.

Commands retain native invocation case and collision suffixes such as `:1`. Unknown commands fail, rather than becoming model prompts. Native command-only completion receipts are not fabricated model answers; terminal extension UI is not rendered as Web UI.

On an owned idle session, `/compact` or `/compact <custom instructions>` invokes native `session.compact()` on that same retained session. Wait for its persisted native result. Busy bindings refuse a second writer; failure never invokes host summarization or CLI compaction. Channel commands require stable transport message IDs for deduplication; authenticated conversation commands generate native receipt IDs. Work commands remain coordinator-owned.

## 8. Cancellation, drain and historical policy

Cancellation stops the bound native process and session MCP sidecars without deleting persistent work volumes. Docker operations participate in tracked runtime ownership/cancellation. Termination is bounded cleanup, not rollback of arbitrary tool effects. Unknown side effects and remote acknowledgements remain unknown; no task replay may manufacture completion or claim remote exactly-once delivery. Busy session/sandbox admission leaves unclaimed delegated work queued until its normal lease is available.

One runtime owner must complete recovery before admission. Loss of ownership stops new work; shutdown stops coordinators/brokers, drains or aborts tracked operations and releases ownership last. Dirty markers survive uncertain cleanup. HTTP liveness is not readiness, and changing the database/domain or deleting a recovery marker is not a takeover procedure. Follow [Runtime Operations](./RUNTIME_OPERATIONS.md), including its exact one-restart recovery acknowledgement requirements.

**Non-Pi and unresolved historical sessions remain read-only.** Preserve stored messages, responses and bound-file reads, historical parsing/archive access, and cancellation/drain for real already-bound operations. Do not launch, resume, replay, upload to or open an execution terminal on a retired runtime. Retired Hermes execution/model/profile/runtime MCP/dashboard/terminal/upload endpoints return HTTP **410**, not a compatibility route to Pi. The old `pi-harness` task tag identifies bound cleanup only. Controlled conversion requires drained old tasks, a fresh Pi draft and new reviewed grants; it never restores old runtime state or automatically republishes public packages.

Use correlation IDs, statuses, durations and failure types for diagnosis. Agent-content capture requires explicit time-limited authorization; see [Observability](./OBSERVABILITY.md). Do not paste complete native output, prompts or private configuration into public issues.

## 9. Regression sources and evidence boundaries

The retained [`native-runtime-session.test.ts`](../tests/integration/native-runtime-session.test.ts) is an unconditional native SDK daemon regression, not an environment-gated real CLI/container matrix. It does not establish live provider or Docker acceptance.

[`pi-sdk-host.test.ts`](../tests/integration/pi-sdk-host.test.ts) launches the real SDK host using the repository's installed `@earendil-works/pi-coding-agent` dependency, temporary directories and controlled local HTTP model/MCP/approval fixtures. It needs the pinned dependencies, a compatible Node environment, child-process execution and local socket/file access; it is not a paid-provider test or a preinstalled sandbox recipe. [`pi-sdk-capabilities.test.ts`](../tests/integration/pi-sdk-capabilities.test.ts) exercises the installed native extension/Skill loader and namespace checks outside Vitest's module transform.

For database/Docker-dependent lease and communication suites, use only an approved isolated environment and the fixed capture image, run serially, and follow the prerequisites in [Runtime Operations](./RUNTIME_OPERATIONS.md#native-sdk-verification) and each test source. Do not use production Agent sandboxes, run concurrent suites against the same database, or present parser/unit/controlled-host results as live provider acceptance. Native compaction requires its own evidence; communication smoke does not cover it.

SDK changes must keep revision preparation/CAS, native preflight, frozen artifacts, live broker authority, session pins, independent volumes, commands and cancellation consistent. Update both language versions with the implementation; never restore a retired executable alias to satisfy an old consumer or test.
