'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, CopyPlus, Loader2, X } from 'lucide-react';
import { useFormStatus } from 'react-dom';
import { cloneAgentAction } from '@/lib/agents/actions';
import { isDedicatedSandboxRuntimeKind } from '@/lib/agents/runtime-kind';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/Dialog';

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
    hermesEnvironment: runtimeKind === 'hermes',
    hermesVolume: runtimeKind === 'hermes',
  };
}

function CloneSubmitButton() {
  const t = useTranslations('console.agents');
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="ui-button-primary h-10 gap-2 px-4 disabled:cursor-wait disabled:opacity-70"
    >
      {pending ? <Loader2 className="size-[18px] shrink-0 animate-spin" /> : <CopyPlus className="size-[18px] shrink-0" />}
      {pending ? t('cloning') : t('cloneAgent')}
    </button>
  );
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
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-3 transition-colors hover:bg-muted/40">
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 rounded border-border"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
    </label>
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
  const t = useTranslations('console.agents');
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<CloneScope>(defaultScope);
  const isHermes = runtimeKind === 'hermes';
  const requiresNewSandbox = isDedicatedSandboxRuntimeKind(runtimeKind);
  const isComplete = scope.mcp
    && scope.skills
    && scope.toolkits
    && scope.sandboxes
    && scope.subAgents
    && scope.conversations
    && (!isHermes || (scope.hermesEnvironment && scope.hermesVolume));

  function updateScope(key: keyof CloneScope, checked: boolean) {
    setScope((current) => {
      if (key === 'hermesVolume' && checked) {
        return { ...current, hermesVolume: true, conversations: true };
      }
      if (key === 'conversations' && !checked && current.hermesVolume) {
        return { ...current, conversations: false, hermesVolume: false };
      }
      return { ...current, [key]: checked };
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setScope(defaultScope());
        setOpen(nextOpen);
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          disabled={requiresNewSandbox}
          aria-label={requiresNewSandbox ? t('cloneRequiresNewSandbox') : t('cloneAgent')}
          title={requiresNewSandbox ? t('cloneRequiresNewSandbox') : t('cloneAgent')}
          className="ui-button-secondary size-10 shrink-0 px-0 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <CopyPlus className="size-[18px] shrink-0" />
        </button>
      </DialogTrigger>

      <DialogPortal>
        <DialogOverlay className="!bg-black/40" />
        <DialogContent className="ui-panel !block !max-h-[calc(100vh-2rem)] !w-full !max-w-2xl !gap-0 !overflow-y-auto !p-0 shadow-xl">
          <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <DialogTitle className="!text-base !leading-normal !tracking-normal text-foreground">
                {t('cloneAgentDialogTitle')}
              </DialogTitle>
              <DialogDescription className="mt-1 !text-xs">{t('cloneAgentDialogDescription')}</DialogDescription>
            </div>
            <DialogClose asChild>
              <button
                type="button"
                aria-label={t('close')}
                title={t('close')}
                className="ui-button-secondary size-9 shrink-0 px-0"
              >
                <X className="size-4" />
              </button>
            </DialogClose>
          </header>

          <form action={cloneAgentAction} className="space-y-5 px-5 py-5">
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name="agentId" value={agentId} />
              <input type="hidden" name="cloneOptions" value="1" />

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-foreground">{t('cloneName')}</span>
                <input
                  name="cloneName"
                  defaultValue={t('agentCopyName', { name: agentName })}
                  maxLength={60}
                  autoFocus
                  className="ui-input h-10 w-full"
                />
              </label>

              <div className="rounded-md border border-primary/25 bg-primary/5 p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-foreground">{t('completeClone')}</p>
                    <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t('completeCloneDescription')}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('completeCloneExclusions')}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setScope(completeScope(runtimeKind))}
                    className="ui-button-secondary h-9 gap-2 px-3 text-xs"
                  >
                    {isComplete ? <Check className="size-3.5" /> : <CopyPlus className="size-3.5" />}
                    {isComplete ? t('completeCloneSelected') : t('selectCompleteClone')}
                  </button>
                </div>
              </div>

              <fieldset>
                <legend className="mb-2 text-xs font-semibold text-foreground">{t('cloneScope')}</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <ScopeCheckbox
                    name="copyMcp"
                    checked={scope.mcp}
                    onChange={(checked) => updateScope('mcp', checked)}
                    label={t('copyMcpBindings')}
                    description={t('copyMcpBindingsDescription')}
                  />
                  <ScopeCheckbox
                    name="copySkills"
                    checked={scope.skills}
                    onChange={(checked) => updateScope('skills', checked)}
                    label={t('copySkillBindings')}
                    description={t('copySkillBindingsDescription')}
                  />
                  <ScopeCheckbox
                    name="copyToolkits"
                    checked={scope.toolkits}
                    onChange={(checked) => updateScope('toolkits', checked)}
                    label={t('copyToolkitBindings')}
                    description={t('copyToolkitBindingsDescription')}
                  />
                  <ScopeCheckbox
                    name="copySandboxes"
                    checked={scope.sandboxes}
                    onChange={(checked) => updateScope('sandboxes', checked)}
                    label={t('copySandboxBindings')}
                    description={t('copySandboxBindingsDescription')}
                  />
                  <ScopeCheckbox
                    name="copySubAgents"
                    checked={scope.subAgents}
                    onChange={(checked) => updateScope('subAgents', checked)}
                    label={t('copySubAgentBindings')}
                    description={t('copySubAgentBindingsDescription')}
                  />
                  <ScopeCheckbox
                    name="copyConversations"
                    checked={scope.conversations}
                    onChange={(checked) => updateScope('conversations', checked)}
                    label={t('copyConversations')}
                    description={t('copyConversationsDescription')}
                  />
                  {isHermes ? (
                    <>
                      <ScopeCheckbox
                        name="copyHermesEnvironment"
                        checked={scope.hermesEnvironment}
                        onChange={(checked) => updateScope('hermesEnvironment', checked)}
                        label={t('copyHermesEnvironment')}
                        description={t('copyHermesEnvironmentDescription')}
                      />
                      <ScopeCheckbox
                        name="copyHermesVolume"
                        checked={scope.hermesVolume}
                        onChange={(checked) => updateScope('hermesVolume', checked)}
                        label={t('copyHermesVolume')}
                        description={t('copyHermesVolumeDescription')}
                      />
                    </>
                  ) : null}
                </div>
                {isHermes && scope.hermesVolume ? (
                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{t('copyHermesVolumeConversationHint')}</p>
                ) : null}
              </fieldset>

              <footer className="flex justify-end gap-2 border-t border-border pt-4">
                <DialogClose asChild>
                  <button type="button" className="ui-button-secondary h-10 px-4">{t('cancel')}</button>
                </DialogClose>
                <CloneSubmitButton />
              </footer>
          </form>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
