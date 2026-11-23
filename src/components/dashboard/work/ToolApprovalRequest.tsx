"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { z } from "zod";
import { ToolApproval } from "@/components/agents/tool-approval";
import {
  FEEDBACK_TOOL_NAME,
  ModelFeedbackToolInputSchema,
} from "@/lib/feedback/types";

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
  const expire = useEffectEvent(() => onExpire?.(card.id));
  useEffect(() => {
    const remaining = Date.parse(card.expiresAt) - Date.now();
    const finish = () => {
      setExpired(true);
      expire();
    };
    if (remaining <= 0) {
      finish();
      return;
    }
    const timer = window.setTimeout(finish, remaining);
    return () => window.clearTimeout(timer);
  }, [card.expiresAt]);
  const channel = card.entryKind === "channel";
  const feedbackPreview =
    card.toolName === FEEDBACK_TOOL_NAME
      ? parseModelFeedbackSummary(card.argumentSummary)
      : null;
  return (
    <ToolApproval
      tool={
        <span className="whitespace-normal break-all">{card.toolName}</span>
      }
      title={feedbackPreview ? t("feedbackTitle") : t("title")}
      status={expired ? "expired" : busy ? "approving" : "pending"}
      statusLabel={t(expired ? "expired" : busy ? "submitting" : "pending")}
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
          ) : (
            <span className="block whitespace-pre-wrap break-all font-mono text-xs">
              {card.argumentSummary}
            </span>
          )}
          <span className="mt-2 block text-xs">
            {t("expiresAt", {
              time: format.dateTime(new Date(card.expiresAt), {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              }),
            })}
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
