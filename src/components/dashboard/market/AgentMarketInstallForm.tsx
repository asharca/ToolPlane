'use client';
import { Input as BeuiInput } from '@/components/ui/Controls';


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
      <BeuiInput type="hidden" name="workspace" value={workspace} />
      <BeuiInput type="hidden" name="releaseId" value={releaseId} />
      <BeuiInput type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <BeuiInput type="hidden" name="returnTo" value={returnTo} />
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
