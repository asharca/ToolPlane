"use client";

import { useTranslations } from "next-intl";
import type { LiveTaskOutput } from "@/lib/agents/execution/live-output-types";
import { ToolResult } from "@/components/agents/tool-result";
import { StreamingResponse } from "@/components/agents/streaming-response";
import {
  AssistantMarkdown,
  ConversationActivity,
  ToolPayload,
  toolOutputText,
  toolResultUnboundedHeight,
} from "@/components/dashboard/ConversationMessage";
import { SubagentActivity } from "../agents/SubagentActivity";
import type { LiveOutputConnection } from "./useLiveTaskOutput";

const stageKeys = {
  queued: "executionQueued",
  preparing: "executionPreparing",
  "waiting-model": "executionWaitingModel",
  generating: "executionGenerating",
  "tool-running": "executionToolRunning",
} as const;

function formatValue(value: unknown) {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function LiveOutputStatus({
  connection,
}: {
  connection: LiveOutputConnection;
}) {
  const t = useTranslations("console.liveOutput");
  return (
    <p role="status" className="text-xs text-muted-foreground">
      {t(connection)}
    </p>
  );
}

/** The same activity and tool primitives as Work, without native dialog authority. */
export function LiveOutputView({
  output,
  hideText = false,
}: {
  output: LiveTaskOutput;
  hideText?: boolean;
}) {
  const t = useTranslations("console.work");
  const agentsT = useTranslations("console.agents");
  const liveT = useTranslations("console.liveOutput");
  const active = output.active && !output.done;
  const failed = output.activities.some(
    (activity) => activity.isError || activity.status === "failed",
  );
  const cancelled = output.activities.some(
    (activity) => activity.status === "cancelled",
  );
  const stage = output.executionStage
    ? t(stageKeys[output.executionStage])
    : t("thinking");
  return (
    <div
      className="min-w-0 space-y-3"
      data-message-id={`live-${output.taskId}`}
      aria-busy={active || undefined}
    >
      {output.activities.length || active ? (
        <ConversationActivity
          status={active ? "working" : "complete"}
          defaultOpen={failed || cancelled}
          collapseOnComplete={!failed && !cancelled}
          activeLabel={stage}
          summary={
            active
              ? stage
              : failed
                ? t("processFailed")
                : cancelled
                  ? t("processCancelled")
                  : t("processed")
          }
          items={output.activities.map((activity) => ({
            id: activity.id,
            type: "text" as const,
            content: activity.source ? (
              <SubagentActivity
                value={{
                  ...activity,
                  type: activity.type === "reasoning" ? "reasoning" : "tool",
                }}
              />
            ) : activity.type === "tool" ? (
              <ToolResult
                className="rounded-xl border-border/60 bg-background"
                tool={
                  activity.deploymentName && activity.originalToolName
                    ? `${activity.deploymentName} · ${activity.originalToolName}`
                    : (activity.toolName ?? activity.originalToolName ?? "")
                }
                title={
                  activity.status === "running"
                    ? t("toolRunning")
                    : activity.isError || activity.status === "failed"
                      ? t("toolFailed")
                      : activity.status === "cancelled"
                        ? t("toolCancelled")
                        : t("toolCompleted")
                }
                status={
                  activity.isError || activity.status === "failed"
                    ? "error"
                    : activity.status === "cancelled"
                      ? "cancelled"
                      : activity.status === "running"
                        ? "running"
                        : "success"
                }
                defaultOpen={
                  activity.status === "running" ||
                  activity.isError ||
                  activity.status === "failed"
                }
                copyText={
                  activity.output === undefined
                    ? undefined
                    : (toolOutputText(activity.output) ??
                      formatValue(activity.output))
                }
                maxHeight={toolResultUnboundedHeight}
              >
                <ToolPayload label={agentsT("toolInput")} language="json">
                  {formatValue(activity.input)}
                </ToolPayload>
                {activity.output !== undefined ? (
                  <ToolPayload
                    label={agentsT("toolOutput")}
                    language={
                      toolOutputText(activity.output) === undefined
                        ? "json"
                        : "text"
                    }
                  >
                    {toolOutputText(activity.output) ??
                      formatValue(activity.output)}
                  </ToolPayload>
                ) : null}
              </ToolResult>
            ) : activity.type === "reasoning" ? (
              <div>
                <p className="text-xs text-muted-foreground">
                  {activity.status === "running" ? t("thinking") : t("thought")}
                </p>
                <pre className="whitespace-pre-wrap break-words text-xs">
                  {activity.text}
                </pre>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {activity.text ?? activity.runtimeKind}
              </p>
            ),
          }))}
        />
      ) : null}
      {!hideText && output.text ? (
        <StreamingResponse
          status={active ? "streaming" : failed ? "error" : "complete"}
          copyText={output.text}
          announce={false}
        >
          <AssistantMarkdown text={output.text} streaming={active} />
        </StreamingResponse>
      ) : null}
      {!hideText && output.truncated ? (
        <p className="text-xs text-muted-foreground">{liveT("truncated")}</p>
      ) : null}
    </div>
  );
}
