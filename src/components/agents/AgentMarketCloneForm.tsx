'use client';

import { ArrowRight } from 'lucide-react';
import { clonePublicAgentAction } from '@/lib/agents/actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { NativeSelect } from '@/components/ui/NativeSelect';

type WorkspaceOption = { slug: string; name: string };

export function AgentMarketCloneForm({
  releaseId,
  idempotencyKey,
  returnTo,
  workspaces,
  labels,
}: {
  releaseId: string;
  idempotencyKey: string;
  returnTo: string;
  workspaces: WorkspaceOption[];
  labels: {
    workspace: string;
    submit: string;
    pending: string;
  };
}) {
  return (
    <form action={clonePublicAgentAction}>
      <input type="hidden" name="releaseId" value={releaseId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <label className="block">
        <span className="mb-1.5 block text-xs font-semibold text-foreground">{labels.workspace}</span>
        <NativeSelect name="workspace" required className="ui-input h-11 w-full">
          {workspaces.map((workspace) => (
            <option key={workspace.slug} value={workspace.slug}>{workspace.name}</option>
          ))}
        </NativeSelect>
      </label>
      <SubmitButton
        pendingLabel={labels.pending}
        savedLabel={labels.submit}
        flash={false}
        className="ui-button-primary mt-2 h-11 w-full gap-2 px-4"
      >
        {labels.submit}
        <ArrowRight className="size-4" />
      </SubmitButton>
    </form>
  );
}
