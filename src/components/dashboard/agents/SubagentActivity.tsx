"use client";

import { z } from "zod";
import { useTranslations } from "next-intl";
import {
  ConversationActivity,
  ToolPayload,
  toolOutputText,
} from "../ConversationMessage";
import { ToolResult } from "@/components/agents/tool-result";

export const SubagentSourceSchema = z.object({
  subagentId: z.string(),
  subagentVersionId: z.string().optional(),
  subagentName: z.string().optional(),
  parentToolCallId: z.string().optional(),
  depth: z.number().optional(),
});
export type SubagentSource = z.infer<typeof SubagentSourceSchema>;

/** Invocation identity, not the reusable profile name, separates concurrent children. */
export function subagentSourceKey(source?: SubagentSource) {
  return source
    ? JSON.stringify([
        source.subagentId,
        source.subagentVersionId,
        source.parentToolCallId,
        source.depth,
      ])
    : "parent";
}

export function SubagentSourceLabel({ source }: { source: SubagentSource }) {
  const t = useTranslations("console.work.nativeUi");
  return (
    <span
      className="break-words text-xs font-medium text-muted-foreground"
      title={[
        source.subagentId,
        source.subagentVersionId,
        source.parentToolCallId,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      {t("source", {
        name: source.subagentName
          ? `${source.subagentName} · ${source.subagentId}`
          : source.subagentId,
      })}
    </span>
  );
}

export const SubagentActivitySchema = z.object({
  type: z.enum(["reasoning", "tool"]),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  source: SubagentSourceSchema,
  text: z.string().optional(),
  delta: z.string().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  isError: z.boolean().optional(),
});

/** Child activities never become parent reasoning, answers or tool results. */
export function SubagentActivity({ value }: { value: unknown }) {
  const t = useTranslations("console.work");
  const parsed = SubagentActivitySchema.safeParse(value);
  if (!parsed.success) return null;
  const activity = parsed.data;
  const failed = activity.status === "failed" || activity.isError;
  return (
    <section className="min-w-0 space-y-2 rounded-xl border border-border/60 p-3">
      <SubagentSourceLabel source={activity.source} />
      {activity.type === "reasoning" ? (
        <ConversationActivity
          status={activity.status === "running" ? "working" : "complete"}
          activeLabel={t("thinking")}
          summary={t("thought")}
          items={[
            {
              id: activity.toolCallId ?? subagentSourceKey(activity.source),
              type: "text",
              content: (
                <pre className="whitespace-pre-wrap break-words text-xs">
                  {activity.text ?? activity.delta}
                </pre>
              ),
            },
          ]}
        />
      ) : (
        <ToolResult
          tool={activity.toolName ?? t("nativeUi.childExecution")}
          title={t(
            activity.status === "running"
              ? "toolRunning"
              : activity.status === "cancelled"
                ? "toolCancelled"
                : failed
                  ? "toolFailed"
                  : "toolCompleted",
          )}
          status={
            activity.status === "running"
              ? "running"
              : activity.status === "cancelled"
                ? "cancelled"
                : failed
                  ? "error"
                  : "success"
          }
          defaultOpen={activity.status === "running" || failed}
        >
          {activity.input !== undefined ? (
            <ToolPayload label={t("nativeUi.childExecution")} language="json">
              {toolOutputText(activity.input) ??
                JSON.stringify(activity.input, null, 2) ??
                ""}
            </ToolPayload>
          ) : null}
          {activity.output !== undefined ? (
            <ToolPayload label={t("result")} language="text">
              {toolOutputText(activity.output) ??
                JSON.stringify(activity.output, null, 2) ??
                ""}
            </ToolPayload>
          ) : null}
        </ToolResult>
      )}
    </section>
  );
}
