"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { z } from "zod";
import { ToolApproval } from "@/components/agents/tool-approval";

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
  return (
    <ToolApproval
      tool={
        <span className="whitespace-normal break-all">{card.toolName}</span>
      }
      title={t("title")}
      status={expired ? "expired" : busy ? "approving" : "pending"}
      statusLabel={t(expired ? "expired" : busy ? "submitting" : "pending")}
      description={
        <>
          <span className="block whitespace-pre-wrap break-all font-mono text-xs">
            {card.argumentSummary}
          </span>
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
