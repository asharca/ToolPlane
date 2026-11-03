"use client";

import { useTranslations } from "next-intl";
import type { McpCallDetail as McpCallDetailView } from "@/lib/observability/views/types";
import { Duration, RelativeTime, StatusBadge } from "./LogPrimitives";
import {
  BodyNotice,
  ContentBlocks,
  JsonPanel,
  JsonTree,
} from "./ProtocolContent";
import { Timeline } from "./Timeline";

export function McpCallDetail({ detail }: { detail: McpCallDetailView }) {
  const t = useTranslations("console.observability.viewer");
  const { summary, request, response } = detail;
  const envelope =
    request !== null && typeof request === "object" && !Array.isArray(request)
      ? request
      : null;
  const params = envelope?.params;
  const argumentsValue =
    params !== null && typeof params === "object" && !Array.isArray(params)
      ? params.arguments
      : undefined;
  const resultEnvelope =
    response !== null &&
    typeof response === "object" &&
    !Array.isArray(response)
      ? response
      : null;
  const result = resultEnvelope?.result;
  const resultObject =
    result !== null && typeof result === "object" && !Array.isArray(result)
      ? result
      : null;
  const argumentsShown = argumentsValue ?? request;
  // Truncated bodies still hold most of the payload; show them below the notice.
  const bodyVisible =
    detail.bodyState === "available" || detail.bodyState === "truncated";
  const upstreamVisible =
    detail.upstream?.bodyState === "available" ||
    detail.upstream?.bodyState === "truncated";
  return (
    <div className="min-w-0 space-y-6">
      <header className="space-y-3">
        <h1 className="break-words text-xl font-semibold">
          {summary.tool ?? summary.method ?? t("unknownOperation")}
        </h1>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <StatusBadge status={summary.outcome} />
          <Duration ms={summary.durationMs} />
          <span>{summary.deployment?.name ?? summary.server?.name}</span>
          <span>
            {summary.caller.kind === "unknown"
              ? t("unknownCaller")
              : summary.caller.name}
          </span>
          <RelativeTime value={summary.createdAt} />
        </div>
        {summary.error && (
          <p className="text-sm text-destructive">{summary.error}</p>
        )}
        <p className="break-all font-mono text-xs text-muted-foreground">
          {t("callId")}: {summary.callId ?? summary.eventId}
        </p>
      </header>
      <BodyNotice state={detail.bodyState} />
      {bodyVisible && (
        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          <JsonPanel title={t("arguments")} value={argumentsShown} />
          <JsonPanel title={t("result")} value={response}>
            {resultObject ? (
              <div className="space-y-3">
                {resultObject.isError === true && (
                  <StatusBadge status="error" />
                )}
                {Array.isArray(resultObject.content) && (
                  <ContentBlocks blocks={resultObject.content} />
                )}
                {resultObject.structuredContent !== undefined && (
                  <section className="space-y-2">
                    <h3 className="text-xs font-medium text-muted-foreground">
                      {t("structuredContent")}
                    </h3>
                    <JsonTree value={resultObject.structuredContent} />
                  </section>
                )}
                {!Array.isArray(resultObject.content) &&
                  resultObject.structuredContent === undefined && (
                    <JsonTree value={resultObject} />
                  )}
              </div>
            ) : (
              <JsonTree value={response} />
            )}
          </JsonPanel>
        </div>
      )}
      {detail.upstream && (
        <details className="space-y-3 rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            {t("upstream")}
          </summary>
          <BodyNotice state={detail.upstream.bodyState} />
          {upstreamVisible && (
            <div className="mt-3 grid gap-3 xl:grid-cols-2">
              <JsonPanel title={t("request")} value={detail.upstream.request} />
              <JsonPanel
                title={t("response")}
                value={detail.upstream.response}
              />
            </div>
          )}
        </details>
      )}
      <Timeline entries={detail.trace} />
    </div>
  );
}
