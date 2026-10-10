"use client";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { FormCheckbox } from "@/components/ui/FormCheckbox";
import {
  CenterMorphModal,
  CenterMorphModalTrigger,
  CenterMorphModalClose,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, CopyPlus } from "lucide-react";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { cloneAgentAction } from "@/lib/agents/actions";
import { isDedicatedSandboxRuntimeKind } from "@/lib/agents/runtime-kind";

type CloneScope = {
  mcp: boolean;
  skills: boolean;
  toolkits: boolean;
  sandboxes: boolean;
  subAgents: boolean;
  conversations: boolean;
  hermesEnvironment: boolean;
  hermesVolume: boolean;
};

function defaultScope(): CloneScope {
  return {
    mcp: true,
    skills: true,
    toolkits: true,
    sandboxes: true,
    subAgents: true,
    conversations: false,
    hermesEnvironment: false,
    hermesVolume: false,
  };
}

function completeScope(runtimeKind: string): CloneScope {
  return {
    mcp: true,
    skills: true,
    toolkits: true,
    sandboxes: true,
    subAgents: true,
    conversations: true,
    hermesEnvironment: runtimeKind === "hermes",
    hermesVolume: runtimeKind === "hermes",
  };
}

function ScopeCheckbox({
  checked,
  description,
  label,
  name,
  onChange,
}: {
  checked: boolean;
  description: string;
  label: string;
  name: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-3 transition-colors hover:bg-muted/40">
      <FormCheckbox
        name={name}
        checked={checked}
        label={label}
        onCheckedChange={(checked) => onChange(checked)}
      />
      <span className="min-w-0">
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
    </div>
  );
}

export function CloneAgentButton({
  slug,
  agentId,
  agentName,
  runtimeKind,
}: {
  slug: string;
  agentId: string;
  agentName: string;
  runtimeKind: string;
}) {
  const t = useTranslations("console.agents");
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<CloneScope>(defaultScope);
  const isHermes = runtimeKind === "hermes";
  const requiresNewSandbox = isDedicatedSandboxRuntimeKind(runtimeKind);
  const isComplete =
    scope.mcp &&
    scope.skills &&
    scope.toolkits &&
    scope.sandboxes &&
    scope.subAgents &&
    scope.conversations &&
    (!isHermes || (scope.hermesEnvironment && scope.hermesVolume));

  function updateScope(key: keyof CloneScope, checked: boolean) {
    setScope((current) => {
      if (key === "hermesVolume" && checked) {
        return { ...current, hermesVolume: true, conversations: true };
      }
      if (isHermes && key === "conversations" && checked) {
        return { ...current, conversations: true, hermesVolume: true };
      }
      if (key === "hermesVolume" && !checked && current.conversations) {
        return { ...current, hermesVolume: false, conversations: false };
      }
      if (key === "conversations" && !checked && current.hermesVolume) {
        return { ...current, conversations: false, hermesVolume: false };
      }
      return { ...current, [key]: checked };
    });
  }

  return (
    <CenterMorphModal
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setScope(defaultScope());
        setOpen(nextOpen);
      }}
    >
      <CenterMorphModalTrigger>
        <Button
          type="button"
          disabled={requiresNewSandbox}
          aria-label={
            requiresNewSandbox ? t("cloneRequiresNewSandbox") : t("cloneAgent")
          }
          title={
            requiresNewSandbox ? t("cloneRequiresNewSandbox") : t("cloneAgent")
          }
          variant={"secondary"}
          size={"icon"}
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
        <header className="flex items-center gap-3 border-b border-border pl-5 pr-16 py-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {t("cloneAgentDialogTitle")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("cloneAgentDialogDescription")}
            </p>
          </div>
        </header>

        <form action={cloneAgentAction} className="space-y-5 px-5 py-5">
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="agentId" value={agentId} />
          <input type="hidden" name="cloneOptions" value="1" />

          <div className="block">
            <Input
              label={t("cloneName")}
              name="cloneName"
              maxLength={60}
              autoFocus
              defaultValue={String(t("agentCopyName", { name: agentName }))}
              className="w-full"
            />
          </div>

          <div className="rounded-md border border-primary/25 bg-primary/5 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {t("completeClone")}
                </p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {t("completeCloneDescription")}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t("completeCloneExclusions")}
                </p>
              </div>
              <Button
                type="button"
                onClick={() => setScope(completeScope(runtimeKind))}
                variant={"secondary"}
                size={"sm"}
              >
                {isComplete ? (
                  <Check className="size-3.5" />
                ) : (
                  <CopyPlus className="size-3.5" />
                )}
                {isComplete
                  ? t("completeCloneSelected")
                  : t("selectCompleteClone")}
              </Button>
            </div>
          </div>

          <fieldset>
            <legend className="mb-2 text-xs font-semibold text-foreground">
              {t("cloneScope")}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <ScopeCheckbox
                name="copyMcp"
                checked={scope.mcp}
                onChange={(checked) => updateScope("mcp", checked)}
                label={t("copyMcpBindings")}
                description={t("copyMcpBindingsDescription")}
              />
              <ScopeCheckbox
                name="copySkills"
                checked={scope.skills}
                onChange={(checked) => updateScope("skills", checked)}
                label={t("copySkillBindings")}
                description={t("copySkillBindingsDescription")}
              />
              <ScopeCheckbox
                name="copyToolkits"
                checked={scope.toolkits}
                onChange={(checked) => updateScope("toolkits", checked)}
                label={t("copyToolkitBindings")}
                description={t("copyToolkitBindingsDescription")}
              />
              <ScopeCheckbox
                name="copySandboxes"
                checked={scope.sandboxes}
                onChange={(checked) => updateScope("sandboxes", checked)}
                label={t("copySandboxBindings")}
                description={t("copySandboxBindingsDescription")}
              />
              <ScopeCheckbox
                name="copySubAgents"
                checked={scope.subAgents}
                onChange={(checked) => updateScope("subAgents", checked)}
                label={t("copySubAgentBindings")}
                description={t("copySubAgentBindingsDescription")}
              />
              <ScopeCheckbox
                name="copyConversations"
                checked={scope.conversations}
                onChange={(checked) => updateScope("conversations", checked)}
                label={t("copyConversations")}
                description={t("copyConversationsDescription")}
              />
              {isHermes ? (
                <>
                  <ScopeCheckbox
                    name="copyHermesEnvironment"
                    checked={scope.hermesEnvironment}
                    onChange={(checked) =>
                      updateScope("hermesEnvironment", checked)
                    }
                    label={t("copyHermesEnvironment")}
                    description={t("copyHermesEnvironmentDescription")}
                  />
                  <ScopeCheckbox
                    name="copyHermesVolume"
                    checked={scope.hermesVolume}
                    onChange={(checked) => updateScope("hermesVolume", checked)}
                    label={t("copyHermesVolume")}
                    description={t("copyHermesVolumeDescription")}
                  />
                </>
              ) : null}
            </div>
            {isHermes && scope.hermesVolume ? (
              <p className="mt-2 text-xs text-muted-foreground text-muted-foreground">
                {t("copyHermesVolumeConversationHint")}
              </p>
            ) : null}
          </fieldset>

          <footer className="flex justify-end gap-2 border-t border-border pt-4">
            <CenterMorphModalClose>
              <Button type="button" variant={"secondary"}>
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
