'use client';

import { useTranslations } from 'next-intl';
import { CopyPlus, Loader2 } from 'lucide-react';
import { useFormStatus } from 'react-dom';
import { cloneAgentAction } from '@/lib/agents/actions';

function CloneSubmitButton() {
  const t = useTranslations('console.agents');
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="ui-button-secondary h-10 gap-2 px-4 text-sm disabled:cursor-wait disabled:opacity-70"
    >
      {pending ? (
        <Loader2 className="size-[18px] shrink-0 animate-spin" />
      ) : (
        <CopyPlus className="size-[18px] shrink-0" />
      )}
      {pending ? t('cloning') : t('cloneAgent')}
    </button>
  );
}

export function CloneAgentButton({
  slug,
  agentId,
  agentName,
}: {
  slug: string;
  agentId: string;
  agentName: string;
}) {
  const t = useTranslations('console.agents');

  return (
    <form action={cloneAgentAction}>
      <input type="hidden" name="workspace" value={slug} />
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="cloneName" value={t('agentCopyName', { name: agentName })} />
      <CloneSubmitButton />
    </form>
  );
}
