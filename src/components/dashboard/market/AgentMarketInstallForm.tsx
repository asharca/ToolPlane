'use client';

import { ArrowRight } from 'lucide-react';
import { installAgentFromMarketAction } from '@/lib/agents/actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';

export function AgentMarketInstallForm({
  workspace,
  releaseId,
  idempotencyKey,
  returnTo,
  labels,
}: {
  workspace: string;
  releaseId: string;
  idempotencyKey: string;
  returnTo: string;
  labels: { submit: string; pending: string };
}) {
  return (
    <form action={installAgentFromMarketAction}>
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="releaseId" value={releaseId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <SubmitButton
        pendingLabel={labels.pending}
        savedLabel={labels.submit}
        flash={false}
        className="ui-button-primary h-10 w-full gap-2 px-4"
      >
        {labels.submit}
        <ArrowRight className="size-4" />
      </SubmitButton>
    </form>
  );
}
