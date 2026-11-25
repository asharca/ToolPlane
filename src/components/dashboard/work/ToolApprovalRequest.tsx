"use client";

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { z } from "zod";
import {
  ToolApproval,
  ToolApprovalCode,
  type ToolApprovalParameter,
} from "@/components/agents/tool-approval";
import { displayToolName } from "@/lib/conversation/content-blocks";
import {
  FEEDBACK_TOOL_NAME,
  ModelFeedbackToolInputSchema,
} from "@/lib/feedback/types";

const CODE_PARAM_KEYS = new Set([
  "command",
  "cmd",
  "script",
  "code",
  "query",
  "patch",
  "content",
]);

function parseStructuredParameters(
  summary: string,
): ToolApprovalParameter[] | null {
  try {
    const parsed: unknown = JSON.parse(summary);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (!entries.length || entries.length > 12) return null;
    return entries.map(([name, val]) => {
      const text =
        typeof val === "string" ? val : (JSON.stringify(val, null, 2) ?? "");
      const isCode =
        CODE_PARAM_KEYS.has(name) || text.includes("\n") || text.length > 100;
      return {
        id: name,
        label: name,
        value: isCode ? (
          <ToolApprovalCode code={text} className="max-h-40 overflow-auto" />
        ) : (
          <span className="block max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
            {text}
          </span>
        ),
      };
    });
  } catch {
    return null;
  }
}

function parseModelFeedbackSummary(summary: string) {
  try {
    const parsed = JSON.parse(summary);
    const result = ModelFeedbackToolInputSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export const ToolApprovalCardSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  argumentHash: z.string(),
  argumentSummary: z.string(),
  entryKind: z.string(),
  expiresAt: z.string().datetime(),
  status: z.string(),
  shortCode: z.string(),
});
export const ToolApprovalDataPartsSchema = z.array(
  z.object({
    type: z.literal("data-tool-approval"),
    id: z.string(),
    data: ToolApprovalCardSchema,
  }),
);
export type ToolApprovalDecision = { id: string; decision: "approve" | "deny" };

export function ToolApprovalRequest({
  card,
  busy,
  disabled,
  onDecide,
  onExpire,
}: {
  card: z.infer<typeof ToolApprovalCardSchema>;
  busy: boolean;
  disabled: boolean;
  onDecide?: (decision: ToolApprovalDecision) => void;
  onExpire?: (id: string) => void;
}) {
  const t = useTranslations("console.toolApproval");
  const format = useFormatter();
  const [expired, setExpired] = useState(
    () => Date.parse(card.expiresAt) <= Date.now(),
  );
  const [remainingSeconds, setRemainingSeconds] = useState(() =>
    Math.max(0, Math.ceil((Date.parse(card.expiresAt) - Date.now()) / 1000)),
  );
  const expire = useEffectEvent(() => onExpire?.(card.id));
  useEffect(() => {
    const targetMs = Date.parse(card.expiresAt);
    const remaining = targetMs - Date.now();
    const finish = () => {
      setExpired(true);
      setRemainingSeconds(0);
      expire();
    };
    if (remaining <= 0) {
      finish();
      return;
    }
    const timer = window.setTimeout(finish, remaining);
    const interval = window.setInterval(() => {
      const next = Math.max(0, Math.ceil((targetMs - Date.now()) / 1000));
      setRemainingSeconds(next);
    }, 1000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [card.expiresAt]);
  const channel = card.entryKind === "channel";
  const feedbackPreview =
    card.toolName === FEEDBACK_TOOL_NAME
      ? parseModelFeedbackSummary(card.argumentSummary)
      : null;
  const structuredParameters = useMemo(
    () =>
      feedbackPreview ? null : parseStructuredParameters(card.argumentSummary),
    [card.argumentSummary, feedbackPreview],
  );
  const countdownText =
    !expired && remainingSeconds > 0
      ? ` (${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")})`
      : "";
  return (
    <ToolApproval
      tool={
        <span className="whitespace-normal break-all" title={card.toolName}>
          {displayToolName(card.toolName)}
        </span>
      }
      title={feedbackPreview ? t("feedbackTitle") : t("title")}
      status={expired ? "expired" : busy ? "approving" : "pending"}
      statusLabel={t(expired ? "expired" : busy ? "submitting" : "pending")}
      labels={{
        approved: t("approved"),
        denied: t("denied"),
        running: t("running"),
        complete: t("completed"),
        error: t("failed"),
        viewDetails: t("viewDetails"),
        alwaysAllow: t("alwaysAllow"),
        expiresIn: (time) => t("expiresIn", { time }),
      }}
      parameters={structuredParameters ?? undefined}
      description={
        <>
          {feedbackPreview ? (
            <div className="space-y-1.5 rounded-lg border border-border/70 bg-background/80 p-3 text-xs text-foreground">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
                  {t(`feedbackCategories.${feedbackPreview.category}`)}
                </span>
                <span className="font-medium break-words">
                  {feedbackPreview.title}
                </span>
              </div>
              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                {feedbackPreview.body}
              </p>
              <p className="pt-1 text-[11px] text-amber-600 dark:text-amber-400">
                {t("feedbackAdminNotice")}
              </p>
            </div>
          ) : structuredParameters ? null : (
            <span className="block max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
              {card.argumentSummary}
            </span>
          )}
          <span className="mt-2 block text-xs tabular-nums">
            {t("expiresAt", {
              time: format.dateTime(new Date(card.expiresAt), {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              }),
            })}
            {countdownText}
          </span>
          {channel ? (
            <span className="mt-2 block">
              {t("channelOnly", { code: card.shortCode })}
            </span>
          ) : null}
        </>
      }
      disabled={disabled || busy || expired}
      readOnly={channel || !onDecide}
      approveLabel={t("approve")}
      denyLabel={t("reject")}
      onApprove={() => onDecide?.({ id: card.id, decision: "approve" })}
      onDeny={() => onDecide?.({ id: card.id, decision: "deny" })}
    />
  );
}
