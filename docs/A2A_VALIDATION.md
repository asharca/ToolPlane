# A2A validation and release gates

Implementation guides: [public service](A2A_NATIVE.md), [local collaboration](A2A_LOCAL_COLLABORATION.md), [内部协作中文指南](A2A_LOCAL_COLLABORATION.zh-CN.md).

Protocol version **1.0** and SDK version **1.2.0** are different identifiers. Use the
pinned official SDK types and JSON-RPC codec; successful private tests are not an
official A2A TCK certification. Internal scheduling phases must never be added to
the A2A TaskState enum or emitted as a private wire protocol.

## Repeatable checks

| Boundary | Check | What it does not establish |
| --- | --- | --- |
| A2A JSON-RPC, Agent Card, errors and event stream | `tests/unit/a2a-protocol.test.ts`, `a2a-http.test.ts` | REST, gRPC, push notifications, OAuth discovery, TCK certification |
| Scoped local entry and explicit enabling | `tests/unit/a2a-local-http.test.ts` | A browser UI or automatic migration of chat/Work |
| Task persistence, continuation and cancellation | `tests/integration/a2a-native.test.ts`, `a2a-local.test.ts` | Exactly-once external side effects |
| Parent continuation and admission races | Concurrency cases in those integration files on PostgreSQL | PGlite explicitly skips these cases and is not equivalent evidence |
| CLI tool bridge | Unmodified MCP SDK client in `a2a-local.test.ts` | A live third-party CLI/model end-to-end result |
| Four local runtime ports and fresh credentials | `tests/unit/a2a-local-executor.test.ts`, `a2a-local-token.test.ts` | Live Pi, Claude Code, DSH or Hermes RPC provider compatibility |
| Architecture and sandbox single writer | `a2a-architecture.test.ts`, `a2a-local-token.test.ts` | Multi-instance runtime ownership or distributed execution |

```bash
pnpm exec prisma generate
pnpm vitest run tests/unit/a2a-*.test.ts tests/integration/a2a-native.test.ts tests/integration/a2a-local.test.ts
pnpm exec tsc --noEmit
pnpm lint
pnpm build
```

Use an isolated PostgreSQL database. Do not set `TOOLPLANE_TEST_PGLITE` in the
PostgreSQL CI job. The repository test files share a database; preserve serial
file execution. The standard CI uses `prisma db push`, which checks the resulting
schema but does not replace applying and validating migration SQL on populated
data.

## Migration and rollout gates

Apply `20260922000000_a2a_native_tasks` before
`20260922010000_a2a_local_collaboration`, then regenerate Prisma Client. In an
isolated populated database, verify that public Context workspace backfill keeps
its client, published revision and task snapshot; local/public target constraints
reject mixed identities; execution phases are backfilled; Agent deletion has the
expected cascades. Do not replay old tasks or migrate private chat history.

Before production rollout, separately exercise real CLI/model delegation,
parallel completion, child questions, revocation, restart during execution,
restart while waiting, and contention with ordinary chat on the same sandbox.
A restarted uncertain execution must fail rather than replay side effects.
Local task sessions are independent, but the configured Agent filesystem and
native memory are not newly isolated per task. Enable only for members entitled
to those resources.

Keep both public and local A2A opt-in. Do not interpret a green build, a passing
SDK mock, or an internal MCP bridge as authorization to enable an Agent, deploy
migrations, expose a private sandbox, or bypass Work approvals.
