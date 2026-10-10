import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import {
  getA2aMetadata,
  getLogEvent,
  getLogTrace,
} from "@/lib/observability/queries";
import { db } from "@/lib/db";
import { CopyButton } from "@/components/dashboard/CopyButton";
import { LogPayload } from "@/components/dashboard/LogPayload";
import { LogOutcomeBadge } from "@/components/admin/LogUI";
import {
  DashboardPage,
  DashboardPanel,
} from "@/components/dashboard/DashboardUI";

export const dynamic = "force-dynamic";

const returnKeys = [
  "q",
  "outcome",
  "direction",
  "agentId",
  "taskId",
  "contextId",
  "rootTaskId",
  "parentTaskId",
  "requestId",
  "range",
  "since",
  "until",
  "cursor",
] as const;

export default async function ObservabilityDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspace: slug, id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/app/login");
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) notFound();
  const scope = { userId: user.id, workspaceId: workspace.id };
  const event = await getLogEvent(scope, id);
  if (event?.domain !== "a2a") notFound();
  const a2a = getA2aMetadata(event.attributes);
  const trace = await getLogTrace(scope, event.traceId);
  const [actor, agent, endpoint, t] = await Promise.all([
    event.actorId
      ? db.user.findUnique({
          where: { id: event.actorId },
          select: { name: true, email: true },
        })
      : null,
    event.agentId
      ? db.agent.findFirst({
          where: { id: event.agentId, workspaceId: workspace.id },
          select: { name: true },
        })
      : null,
    a2a?.endpointId
      ? db.agentEndpoint.findFirst({
          where: { id: a2a.endpointId, workspaceId: workspace.id },
          select: { name: true },
        })
      : null,
    getTranslations("console.observability"),
  ]);
  const query = await searchParams;
  const filters = new URLSearchParams({ tab: "a2a" });
  for (const key of returnKeys) {
    const value = query[key];
    if (typeof value === "string" && value.length <= 1000)
      filters.set(key, value);
  }
  const base = `/app/${encodeURIComponent(slug)}/observability`;
  const backHref = `${base}?${filters}`;
  const detailHref = (rowId: string) =>
    `${base}/${encodeURIComponent(rowId)}?${filters}`;
  const filterHref = (key: string, value: string) => {
    const next = new URLSearchParams({ tab: "a2a", [key]: value });
    if (
      typeof query.range === "string" &&
      ["1", "24", "168"].includes(query.range)
    )
      next.set("range", query.range);
    return `${base}?${next}`;
  };
  const fields = [
    ["eventId", event.id],
    ["agentId", event.agentId],
    ["endpointId", a2a?.endpointId],
    ["clientId", a2a?.clientId],
    ["remoteAgentId", a2a?.remoteAgentId],
    ["requestId", event.requestId],
    ["traceId", event.traceId],
    ["taskId", a2a?.taskId],
    ["contextId", a2a?.contextId],
    ["rootTaskId", a2a?.rootTaskId],
    ["parentTaskId", a2a?.parentTaskId],
  ] as const;
  const searchable: Record<string, true> = {
    agentId: true,
    endpointId: true,
    requestId: true,
    taskId: true,
    contextId: true,
    rootTaskId: true,
    parentTaskId: true,
    traceId: true,
    clientId: true,
    remoteAgentId: true,
  };
  const caller =
    actor?.name ??
    actor?.email ??
    event.actorId ??
    (a2a?.clientId ? `${t("a2aServiceClient")} · ${a2a.clientId}` : "—");
  const target =
    agent?.name ??
    endpoint?.name ??
    event.agentId ??
    a2a?.endpointId ??
    a2a?.remoteAgentId ??
    t("a2aNoTarget");
  const readable =
    event.detailState === "available" || event.detailState === "truncated";
  const data = readable ? event.detail?.data : null;
  const payload =
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    data.payload &&
    typeof data.payload === "object" &&
    !Array.isArray(data.payload)
      ? data.payload
      : null;
  const bodyUnavailable = t(
    event.detailState === "expired"
      ? "bodyExpired"
      : event.detailState === "restricted"
        ? "bodyRestricted"
        : "bodyUnavailable",
  );
  const responseUnavailable =
    payload?.responseKind === "none"
      ? t(payload.responseComplete ? "noResponseBody" : "noResponseReceived")
      : bodyUnavailable;

  return (
    <DashboardPage>
      <Link href={backHref} className="text-sm text-primary hover:underline">
        ← {t("a2aBack")}
      </Link>
      <h1 className="break-all text-xl font-semibold">
        {event.rpcMethod ?? event.eventName}
      </h1>
      <DashboardPanel title={t("a2aMetadata")}>
        <dl className="grid gap-4 sm:grid-cols-2">
          {(
            [
              ["a2aMethod", event.rpcMethod ?? event.eventName],
              ["direction", a2a ? t(`directions.${a2a.direction}`) : "—"],
              ["a2aTarget", target],
              [
                "a2aResult",
                <LogOutcomeBadge key="outcome" outcome={event.outcome} />,
              ],
              [
                "a2aTaskState",
                a2a?.taskState
                  ? t.has(`taskStates.${a2a.taskState}`)
                    ? t(`taskStates.${a2a.taskState}`)
                    : a2a.taskState
                  : "—",
              ],
              [
                "a2aEventDuration",
                event.durationMs === null ? "—" : `${event.durationMs} ms`,
              ],
              [
                "a2aHttpStatus",
                event.httpStatus === null ? "—" : `HTTP ${event.httpStatus}`,
              ],
              ["a2aEventTime", event.createdAt.toISOString()],
              ["a2aCaller", caller],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{t(label)}</dt>
              <dd className="mt-1 break-all text-sm">{value}</dd>
            </div>
          ))}
        </dl>
        <dl className="mt-5 grid gap-4 border-t border-border pt-5 sm:grid-cols-2">
          {fields.map(([key, value]) =>
            value ? (
              <div key={key} className="min-w-0">
                <dt className="text-xs text-muted-foreground">
                  {t.has(key) ? t(key) : key}
                </dt>
                <dd className="mt-1 flex items-center gap-2 break-all font-mono text-xs">
                  {searchable[key] ? (
                    <Link
                      href={filterHref(
                        key === "traceId" ||
                          key === "clientId" ||
                          key === "remoteAgentId"
                          ? "q"
                          : key,
                        value,
                      )}
                      className="min-w-0 flex-1 text-primary hover:underline"
                    >
                      {value}
                    </Link>
                  ) : (
                    <span className="min-w-0 flex-1">{value}</span>
                  )}
                  <CopyButton text={value} iconOnly label={key} />
                </dd>
              </div>
            ) : null,
          )}
        </dl>
      </DashboardPanel>
      <DashboardPanel title={t("a2aDetails")}>
        <div className="grid min-w-0 gap-6 xl:grid-cols-2">
          <LogPayload
            label={t("requestBody")}
            value={
              payload && Object.hasOwn(payload, "request")
                ? JSON.stringify(payload.request, null, 2)
                : null
            }
            copyLabel={t("copyBody", { label: t("requestBody") })}
            unavailableText={bodyUnavailable}
          />
          <div className="min-w-0 space-y-3">
            {payload?.responseKind === "sse" ? (
              <p className="text-xs text-muted-foreground">
                {t("sseResponse")} ·{" "}
                {t(
                  event.detailState === "truncated"
                    ? "truncated"
                    : payload.responseComplete
                      ? "responseComplete"
                      : "responseDisconnected",
                )}
              </p>
            ) : null}
            <LogPayload
              label={t("responseBody")}
              value={
                payload && Object.hasOwn(payload, "response")
                  ? JSON.stringify(payload.response, null, 2)
                  : null
              }
              copyLabel={t("copyBody", { label: t("responseBody") })}
              unavailableText={responseUnavailable}
            />
          </div>
        </div>
        {readable && event.detail ? (
          <p className="mt-4 text-xs text-muted-foreground">
            {event.detailState === "truncated" ? `${t("truncated")} · ` : ""}
            {t("bodyExpires")}: {event.detail.expiresAt.toISOString()}
          </p>
        ) : null}
        {event.detailState === "restricted" && user.role === "admin" ? (
          <Link
            href={`/admin/logs/${encodeURIComponent(event.id)}`}
            className="mt-3 inline-block text-sm text-primary hover:underline"
          >
            {t("a2aViewBodyAdmin")}
          </Link>
        ) : null}
      </DashboardPanel>
      <DashboardPanel title={t("a2aTrace")}>
        <ol className="space-y-3 border-l border-border pl-4">
          {trace.map((row) => (
            <li key={row.id}>
              {row.domain === "a2a" ? (
                <Link
                  href={detailHref(row.id)}
                  aria-current={row.id === event.id ? "step" : undefined}
                  className="block break-all text-sm text-primary hover:underline"
                >
                  {row.createdAt.toISOString()} · {row.eventName} ·{" "}
                  {row.outcome}
                </Link>
              ) : (
                <span className="block break-all text-sm">
                  {row.createdAt.toISOString()} · {row.eventName} ·{" "}
                  {row.outcome}
                </span>
              )}
            </li>
          ))}
        </ol>
      </DashboardPanel>
    </DashboardPage>
  );
}
