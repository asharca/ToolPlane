"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { CopyPlus } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { FormCheckbox } from "@/components/ui/FormCheckbox";
import {
  CenterMorphModal,
  CenterMorphModalTrigger,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { cloneAgentAction } from "@/lib/agents/actions";
import {
  DialogBody,
  DialogCancel,
  DialogField,
  DialogFooter,
  DialogHeader,
} from "@/components/dashboard/dialog";

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
        className="flex max-h-[calc(100dvh-4rem)] max-w-2xl flex-col"
      >
        <CloneAgentForm
          key={String(open)}
          slug={slug}
          agentId={agentId}
          agentName={agentName}
        />
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}

function CloneAgentForm({
  slug,
  agentId,
  agentName,
}: {
  slug: string;
  agentId: string;
  agentName: string;
}) {
  const t = useTranslations("console.agents");
  const initialName = String(t("agentCopyName", { name: agentName }));
  const [name, setName] = useState(initialName);
  const [copyConversations, setCopyConversations] = useState(false);
  const nameId = useId();
  const copyId = useId();
  return (
    <form action={cloneAgentAction} className="flex min-h-0 flex-col">
      <DialogHeader
        title={t("cloneAgentDialogTitle")}
        description={t("cloneDraftDescription")}
      />
      <DialogBody>
        <input type="hidden" name="workspace" value={slug} />
        <input type="hidden" name="agentId" value={agentId} />
        <input type="hidden" name="cloneOptions" value="1" />
        <DialogField
          label={t("cloneName")}
          htmlFor={nameId}
          dirty={name !== initialName}
        >
          <Input
            id={nameId}
            name="cloneName"
            maxLength={60}
            autoFocus
            value={name}
            onChange={setName}
            className="w-full"
          />
        </DialogField>
        <DialogField
          label={t("copyReadOnlyHistory")}
          htmlFor={copyId}
          dirty={copyConversations}
          description={t("copyReadOnlyHistoryDescription")}
        >
          <FormCheckbox
            name="copyConversations"
            id={copyId}
            label=""
            checked={copyConversations}
            onCheckedChange={setCopyConversations}
          />
        </DialogField>
      </DialogBody>
      <DialogFooter cancel={<DialogCancel />}>
        <SubmitButton size="md" pendingLabel={t("cloning")} flash={false}>
          <CopyPlus className="size-4" />
          {t("cloneAgent")}
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}
