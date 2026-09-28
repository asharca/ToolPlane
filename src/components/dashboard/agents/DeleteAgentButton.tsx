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
        triggerVariant="ghost" triggerSize="icon"
        
        
      />
    </form>
  );
}
