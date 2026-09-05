'use client';

import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { deleteAgentAction } from '@/lib/agents/actions';
import { ConfirmSubmitButton } from '@/components/dashboard/ConfirmSubmitButton';

export function DeleteAgentButton({
  slug,
  agentId,
  returnTo,
  prompt,
  compact = false,
}: {
  slug: string;
  agentId: string;
  returnTo?: string;
  prompt?: string;
  compact?: boolean;
}) {
  const t = useTranslations('console.agents');

  return (
    <form action={deleteAgentAction} className="flex flex-wrap items-center gap-2.5">
      <input type="hidden" name="workspace" value={slug} />
      <input type="hidden" name="agentId" value={agentId} />
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
      <ConfirmSubmitButton
        triggerLabel={<Trash2 className="size-[18px] shrink-0" />}
        triggerAriaLabel={t('deleteAgent')}
        triggerTitle={t('deleteAgent')}
        confirmLabel={t('confirmDelete')}
        cancelLabel={t('cancel')}
        prompt={prompt ?? t('deleteThisAgentAndItsSandboxesAndAllItsConversations')}
        pendingLabel={t('deleting')}
        triggerClassName={compact
          ? 'inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-red-200 p-0 text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-950/30'
          : 'inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-red-200 p-0 text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-950/30'}
        confirmClassName="inline-flex h-10 items-center rounded-md bg-red-600 px-4 text-sm font-medium text-white transition-colors hover:bg-red-700"
        cancelClassName="ui-button-secondary h-10 px-4 text-sm"
      />
    </form>
  );
}
