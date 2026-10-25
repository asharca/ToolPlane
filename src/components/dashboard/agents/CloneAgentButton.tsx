"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CopyPlus } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { FormCheckbox } from "@/components/ui/FormCheckbox";
import {
  CenterMorphModal,
  CenterMorphModalTrigger,
  CenterMorphModalClose,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { cloneAgentAction } from "@/lib/agents/actions";

export function CloneAgentButton({
  slug,
  agentId,
  agentName,
}: {
  slug: string;
  agentId: string;
  agentName: string;
}) {
  const t = useTranslations("console.agents");
  const [open, setOpen] = useState(false);
  return (
    <CenterMorphModal open={open} onOpenChange={setOpen}>
      <CenterMorphModalTrigger>
        <Button
          type="button"
          aria-label={t("cloneAgent")}
          title={t("cloneAgent")}
          variant="secondary"
          size="icon"
          className="shrink-0"
        >
          <CopyPlus className="size-[18px] shrink-0" />
        </Button>
      </CenterMorphModalTrigger>
      <CenterMorphModalContent
        ariaLabel={t("cloneAgentDialogTitle")}
        closeButtonLabel={t("close")}
        className="max-w-2xl"
      >
        <header className="border-b border-border pl-5 pr-16 py-4">
          <h2 className="text-base font-semibold">
            {t("cloneAgentDialogTitle")}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("cloneDraftDescription")}
          </p>
        </header>
        <form action={cloneAgentAction} className="space-y-5 p-5">
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="agentId" value={agentId} />
          <input type="hidden" name="cloneOptions" value="1" />
          <Input
            label={t("cloneName")}
            name="cloneName"
            maxLength={60}
            autoFocus
            defaultValue={String(t("agentCopyName", { name: agentName }))}
            className="w-full"
          />
          <div className="space-y-2">
            <FormCheckbox
              name="copyConversations"
              label={t("copyReadOnlyHistory")}
            />
            <p className="text-xs text-muted-foreground">
              {t("copyReadOnlyHistoryDescription")}
            </p>
          </div>
          <footer className="flex justify-end gap-2 border-t border-border pt-4">
            <CenterMorphModalClose>
              <Button type="button" variant="secondary">
                {t("cancel")}
              </Button>
            </CenterMorphModalClose>
            <SubmitButton pendingLabel={t("cloning")} flash={false}>
              <CopyPlus className="size-4" />
              {t("cloneAgent")}
            </SubmitButton>
          </footer>
        </form>
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}
