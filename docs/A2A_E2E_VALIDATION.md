# End-to-end acceptance: evidence, not substituted tests

> This checklist deliberately distinguishes prerequisites, contracts and real acceptance. No item below is considered passed because a mock or preflight exits successfully.

Run `node scripts/a2a-e2e-preflight.mjs` before preparing real staging. It performs bounded, read-only checks, prints no credential values and submits no work. Exit 2 means blocked. Exit 0 only means configuration prerequisites are present, **not E2E passed**.

## Required isolated staging

Use an owned, explicitly authorized disposable deployment, real PostgreSQL, actual Docker and the pinned Pi/Claude Code/DSH/Hermes RPC executables inside their isolated runtimes. Configure a real model with a bounded budget; do not copy production credentials into test artifacts. Provide a staging user and fixture Agent. Set `TOOLPLANE_E2E_STAGING=1` only for this isolated deployment.

The optional configuration names checked by preflight are `TOOLPLANE_E2E_APP_URL`, `TOOLPLANE_E2E_EMAIL`, `TOOLPLANE_E2E_PASSWORD`, `TOOLPLANE_E2E_WORKSPACE`, `TOOLPLANE_E2E_AGENT_ID`, `TOOLPLANE_E2E_REMOTE_CARD_URL` and `TOOLPLANE_A2A_TCK_DIR`. Values must come from staging secret configuration, not committed files.

## Required real acceptance matrix

| Layer | Actual acceptance and evidence |
| --- | --- |
| Native CLI + model | For each pinned runtime, submit a harmless fixture task that writes only to an isolated test path. Observe an actual native call pending before any side effect, approve once, verify the exact result. Repeat denial, expiry, parameter change, disconnect and process interruption. Do not replace the executor or model. |
| All ingress | Use classic Work, classic saved chat, Control MCP and a staging channel. Verify the same native Task/Context tables, stable retries and actor scopes. Confirm an external sender cannot approve. Account for channel final-delivery failures separately from task persistence. |
| Browser | Use the actual Next application and login. Verify visible exact arguments, approve/deny, task progress, refresh recovery, stale permission removal and navigation on desktop/mobile. Capture screenshots privately and inspect them. JS DOM component tests are not this result. |
| Remote TLS | Call an owned public HTTPS fixture using an approved origin and genuine TLS/DNS. Inspect returned Task IDs, polling, cancellation confirmation and an interrupted result. Do not disable DNS pinning, allow private addresses or skip certificate checks just to make the test pass. |
| PostgreSQL | Run the repository integration suite without `TOOLPLANE_TEST_PGLITE=1`; verify contention, one-use decisions and claims against real locks. Apply migration SQL to populated prior schemas separately from `db push`. |
| Full official A2A TCK | Pin and record the upstream revision, install its declared test dependencies, and run the complete suite for the declared JSON-RPC binding against the real authenticated endpoint. Preserve test counts, skips, failures and upstream reports. Do not select only passing MUST checks, synthesize Card/Task responses, or rename a custom subset “full TCK”. |

The upstream TCK runner uses `python run_tck.py --sut-host <base> --transport jsonrpc`. Its authentication setup must be validated against the pinned checkout before use with ToolPlane's protected Agent Card; do not weaken service authentication to accommodate the test harness. Preserve the precise tested commit and declared interface. A full test run is not a third-party certification claim.

## Available contract tests

```bash
pnpm vitest run tests/unit/a2a-approval-http.test.ts tests/unit/a2a-native-tool-approval.test.ts tests/unit/a2a-tool-approvals-ui.test.tsx tests/integration/a2a-local.test.ts
TOOLPLANE_HERMES_SOURCE=/path/to/pinned/hermes python3 tests/contracts/test_hermes_native_approval.py
```

The Python contract test executes the unmodified upstream middleware implementation, but its registry, HTTP service and terminal tool callback are fixtures. The Node helper test executes a real child process with a fixture HTTP response. Neither is real CLI/model E2E. Missing upstream source is a blocked error, not a success/skip report.

## Known release limitations

Managed `hermes` remains a compatibility path. Hermes RPC session-only interactive approvals remain denied when exact per-call binding cannot be established. Classic chat stop-reading is not explicit Task cancellation. Classic views link to the native approval panel rather than all embedding it. Historical memory is not fully imported. Durable channel outbox and final delivery across restarts are not implemented in this increment. These limitations must appear in any release/acceptance summary.
