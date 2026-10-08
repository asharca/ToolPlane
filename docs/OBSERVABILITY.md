# Logging and Audit

> **中文**：[OBSERVABILITY.zh-CN.md](./OBSERVABILITY.zh-CN.md)

The administrator console at `/admin/logs` reads structured events independently
of workspace business records. Workspace observability is restricted to the
signed-in user's workspace: retained deployment MCP request/response details
remain visible where authorized; A2A bodies are administrator-only. Other Agent
and non-deployment API payloads still require their existing explicit policy.

## Health and error triage

`/admin/logs` defaults to all event domains (including exports), with an A2A
request view in addition to HTTP, execution, runtime and audit. The A2A view
defaults to `a2a.request`; explicit event or task/context/root/parent filters
include lifecycle and outbound rows. The collapsible health snapshot always
uses the last 15 minutes across all workspaces, independent of list filters.
Per-domain counts distinguish errors/timeouts (including error severity) from
denials; nested spans are events, not unique requests. No data is shown as unknown,
not healthy. “No errors observed” is not an availability guarantee or an active
provider probe. Refresh reloads the snapshot; it is not a live subscription.

MCP deployment anomalies reconcile persisted status with supervised processes:
failed/error states and missing processes for active deployments need attention;
intentionally stopped deployments do not. Writer failure/drop counters cover only
the current worker since startup. This database-backed screen is not an external
uptime monitor and cannot diagnose a completely unavailable application/database.

Select a domain card, use the failure/timeout/denial shortcuts, then open an error
group or event for diagnostic details and its trace. Error groups start expanded
and show the latest occurrence. Health links pin the event window; the global
health snapshot remains independent. Existing redaction, admin authorization,
detail access audits and retention controls are unchanged.


## Storage

- `LogEvent`: searchable metadata, timestamp, severity, domain, outcome, actual
  HTTP status, RPC method/tool name, duration, error type/code, resource IDs,
  request ID and trace/span/parent span IDs.
- `LogDetail`: optional sanitized error chain/stack and scoped diagnostic payload,
  capped at 32 KiB of valid JSON. Expired details are excluded at read time.
- `AuditEvent`: actor, action, target, before/after changes and correlation IDs.
  Application mutations append these records; entity deletion does not cascade
  into diagnostic or audit history.

`httpStatus` is the transport result; `outcome` is the business result. An MCP
HTTP 200 response with JSON-RPC `error` or `result.isError` is an error. Workspace
MCP metrics count `gateway.request`, not its nested transport or HTTP events.
Counts, averages, P95 and hour buckets are aggregated in Postgres.

## Instrumentation

`withRequestLogging` wraps JSON/gateway handlers before authorization, assigns a
server-generated request ID and records early failures. SSE completion, failure
and cancellation are recorded once, without buffering the response stream.
It does not record raw URLs, headers or request bodies.

`withLogContext` uses AsyncLocalStorage to link child spans. Verified resource
lookups enrich context; caller-provided request IDs are not trusted. Signed
sandbox runtime grants carry trace ancestry across model and MCP callbacks.
Work execution starts a detached context so background jobs cannot inherit
another request's actor. Native runs record model usage, first output latency,
stop reasons and tool results. Hermes/sandbox instrumentation records available
runtime events, not private reasoning or every internal runtime operation.

`recordEvent` also emits sanitized JSON to stderr. Database writes are bounded
to 32 in-flight writes per worker, with short acquisition/transaction deadlines.
Storage failures and overload do not reject business requests. The admin page
shows that worker's failure/drop counters. This is best-effort diagnostics, not
a durable external queue: abrupt process termination or sustained overload can
lose events. An external log collector can ingest stderr if stronger operational
durability is needed. Stderr backpressure is bounded as well.

Critical DB changes use `writeAudit` on the same transaction client: user role
and status, admin settings, provider credentials, account API tokens and Agent
API keys, category edits, catalog metadata/recipes, marketplace reviews and
publishing controls, and individual registry skill writes. Catalog audit entries
exclude manifests, skill bodies and recipe credential values. Audit failure
rolls back the mutation. Deletions involving external
processes record intent before teardown and a final success/failure. Viewing
diagnostic details and exporting logs also require a successful access audit.
This is application-level append-only storage, not tamper-proof storage against
a database administrator.

## Capture and Retention

Defaults are 30 days for events, 7 days for details and 180 days for audit.
Sanitized, bounded payloads for non-Agent MCP deployment requests are retained as
details for the deployment MCP call logs tab and workspace request overview. The transport
records the actual JSON-RPC request and upstream response envelopes, including
upstream errors; a transport failure without a response does not invent one.
Gateway rows reuse their matching workspace-scoped transport details without
duplicating the call. Overview counts and pagination remain gateway-only;
standalone discovery calls remain visible in deployment logs.

Workspace-visible details must carry the permission marker set during safe MCP
capture. Older unmarked details remain metadata-only for workspace readers because
their original capture policy cannot be established; administrator diagnostic
access is unchanged. Expired or unavailable bodies have no copy action.
Authorized A2A protocol, communication-tool and native user-entry boundaries retain
sanitized request/response details by default, without enabling diagnostic capture.
New A2A and deployment MCP payloads expire within `min(detailDays, eventDays, 1)`
days. A2A bodies are administrator-only; workspace members can inspect metadata.
Denied or unauthenticated requests never collect bodies. Existing details are not
extended or backfilled. Empty responses and responses not received are distinct.


Administrators can enable a 15-minute diagnostic capture for an existing
workspace, deployment or agent. Capture start, stop and retention changes are
audited. Public Agent API payloads remain suppressed even when capture is on.
Passwords, credentials, cookies, authorization headers, known runtime/provider
secrets and common token patterns are redacted before database or stderr output.
Arbitrary user text is not guaranteed anonymous; enable payload capture only
when operationally necessary and restrict administrator access accordingly.

Settings cache for at most 10 seconds per worker; expiry is checked on each
write. An explicit stop can take that long to reach other workers. Every five
minutes the Node startup hook attempts cleanup under a Postgres advisory lock.
Cleanup uses at most ten batches of 1,000 rows per table. Detail retention cannot
outlive its parent event. Audit has its own retention policy.

The UI uses 50-row keyset pages and a bounded, at-most-31-day search window.
Trace views cap at 500 events. JSONL exports include at most 1,000 metadata or
audit records, with no payload; the response declares `x-export-limit: 1000`.

## Admin Workflows

- `/admin` prioritizes pending reviews, abnormal effective deployment states and
  recent failures. MCP requests count only `gateway.request`; A2A inbound requests
  count only `a2a.request` with `direction=inbound`. The request panel and recent
  request list do not include nested HTTP, task lifecycle events or outbound polls.
  No requests means unknown request latency, not a healthy service.
- `/admin/reviews` merges market and agent releases into a 25-row queue, oldest
  pending first. Filters include resource type, review status and publisher/name.
  `/admin/market` remains catalog maintenance. Review details show immutable
  artifacts, changed manifest sections, reviewer identity and review notes.
- User and workspace details link to scoped events and audits. `actorId` means
  the operator; `targetType` and `targetId` filter the affected audit resource.
  Detail return links preserve list filters and accept only local admin URLs.
- A2A events correlate by a server-generated request/trace ID for synchronous
  calls and local task/root-task IDs across poll, restart and worker execution.
  Task duration measures time from admission to the last committed status, not
  HTTP latency. The detail page shows actual request/response and RPC errors,
  a matching HTTP entry when present, and audited administrator-only bodies.
  Expired, uncollected, and workspace-restricted details cannot be copied.
- Workspace `/app/[workspace]/observability?tab=a2a` filters A2A request or
  task-chain metadata within the authorized workspace. Task associations never
  expand that scope; members cannot obtain A2A bodies through lists, details,
  traces or exports. An administrator who also belongs to the workspace can
  follow the explicit link to the audited administrator detail page.
- Settings show the latest retained successful audit record and warn before
  leaving unsaved edits. No audit history means no recorded modifier, not
  necessarily that the setting has never changed. Failed saves preserve inputs;
  saving one section does not discard another section's unsaved changes.
- Registry synchronization reports individual failed paths. Retry uses the
  previous result's source and only paths still present in that registry. The
  failure list is page state; refreshing clears it. `pnpm skills:sync:tp` uses
  Node's `react-server` condition for the shared server-only audit writer.

## Breaking Upgrade

Migration `20260907000000_unified_observability` drops `RequestLog` and creates
the three new tables. There is no backfill or dual write. Other business tables
are not changed. Export old logs separately before upgrading if they are needed.

Stop old application workers, apply migrations with
`pnpm exec prisma migrate deploy`, run `pnpm db:generate`, then build and restart
all workers using the new code. Do not run old and new workers against the
migrated database. Prisma clients retained by development HMR also need a full
server restart.

Focused checks:

```bash
pnpm vitest run tests/unit/logging.test.ts tests/unit/logging-storage.test.ts tests/unit/agent-runtime-access.test.ts tests/integration/logging.test.ts tests/integration/observability.test.ts
pnpm exec tsc --noEmit
pnpm lint
```

## Explicit Payload Policy

Events declare `metadata-only` (default), `diagnostic`, `agent-content`, `request-response`, or `forbidden`. Only explicit authorized request boundaries use `request-response`; the 15-minute capture controls additional internal diagnostics, not default A2A bodies. A diagnostic capture does not automatically enable Agent content. An administrator must explicitly select `includeAgentContent` for the named resource, with the existing time limit and access audit. Agent-content details retain for at most 24 hours (or less if configured); exports remain metadata-only.

A lazy detail reader runs only after policy and capture checks. Response readers stop at 32 KiB or 200 ms and do not capture SSE. Sensitive Agent events keep only their generic event name/error category in metadata, omit arbitrary attributes and error text from stderr, and do not copy payloads merely to determine success. Parent `suppressPayload` is monotonic: children cannot turn it off. `forbidden` and public Endpoint suppression override every capture.

Non-Agent `gateway.request` and `mcp.rpc` events scoped to both a workspace and deployment retain their sanitized payload by default for deployment MCP call logs and workspace request logs. Agent contexts and public endpoints are excluded from this default.

Content redaction does not anonymize arbitrary business text. Opt-in captures still require restricted administrator access and minimal retention.
