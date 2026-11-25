"use client";

import { useState } from "react";
import { unstable_rethrow } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import {
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogCancel,
} from "@/components/dashboard/dialog";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { notify } from "@/components/dashboard/Toaster";
import { deleteConversationAction } from "@/lib/agents/conversation-actions";
import { apiRequest } from "@/lib/client/api";
import type { ConversationSummary } from "./work-types";

export type DeleteConversationTarget = ConversationSummary & {
  workSessionId?: string;
};

/**
 * Deletes a Work session through its API, or a chat conversation through the
 * server action (which redirects on success).
 */
export function DeleteConversationDialog({
  slug,
  target,
  onClose,
  onWorkSessionDeleted,
}: {
  slug: string;
  target: DeleteConversationTarget | null;
  onClose: () => void;
  onWorkSessionDeleted: (
    target: ConversationSummary & { workSessionId: string },
  ) => void;
}) {
  const t = useTranslations("console.work");
  const tAgents = useTranslations("console.agents");
  const operationsT = useTranslations("console.conversationOperations");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const workSession = Boolean(target?.workSessionId);
  return (
    <CenterMorphModal
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <CenterMorphModalContent
        ariaLabel={
          workSession ? t("deleteConversation") : tAgents("deleteConversation")
        }
        closeButtonLabel={tAgents("close")}
        className="max-w-md"
      >
        <DialogHeader
          title={
            workSession
              ? t("deleteConversation")
              : tAgents("deleteConversation")
          }
        />
        <DialogBody>
          <p className="text-sm text-muted-foreground">
            {workSession
              ? t("deleteConversationDescription")
              : tAgents("deleteConversationDescription")}
          </p>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <form
          action={async (formData) => {
            if (!target || pending) return;
            setPending(true);
            setError("");
            try {
              const { workSessionId } = target;
              if (workSessionId) {
                const result = await apiRequest(
                  `/api/v1/work-sessions/${encodeURIComponent(workSessionId)}`,
                  { method: "DELETE" },
                );
                if (!result.ok) {
                  setError(result.message ?? t("deleteConversationError"));
                  return;
                }
                notify(t("conversationDeleted"));
                onClose();
                onWorkSessionDeleted({ ...target, workSessionId });
              } else {
                const result = await deleteConversationAction(formData);
                if (result.error) setError(result.error);
              }
            } catch (cause) {
              unstable_rethrow(cause);
              setError(operationsT("failed"));
            } finally {
              setPending(false);
            }
          }}
        >
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="agentId" value={target?.agentId ?? ""} />
          <input type="hidden" name="conversationId" value={target?.id ?? ""} />
          <DialogFooter cancel={<DialogCancel />}>
            <SubmitButton
              size="md"
              variant="primary"
              className="bg-destructive text-white hover:bg-destructive/90"
              pendingLabel={tAgents("deleting")}
              error={error}
              flash={false}
            >
              {tAgents("confirmDelete")}
            </SubmitButton>
          </DialogFooter>
        </form>
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}
