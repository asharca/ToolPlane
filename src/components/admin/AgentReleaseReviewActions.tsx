'use client';

import { CheckCircle2, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useId } from 'react';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import {
  approveAgentReleaseAction,
  rejectAgentReleaseAction,
} from '@/lib/admin/agent-market-actions';
import type { AdminActionState } from '@/lib/admin/user-actions';

function ReviewActionForm({
  listingId,
  releaseId,
  tone,
}: {
  listingId: string;
  releaseId: string;
  tone: 'approve' | 'reject';
}) {
  const action = tone === 'approve' ? approveAgentReleaseAction : rejectAgentReleaseAction;
  const [state, formAction] = useActionState<AdminActionState, FormData>(action, {});
  const t = useTranslations('admin');
  const noteId = useId();
  const approving = tone === 'approve';

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="releaseId" value={releaseId} />
      <label htmlFor={noteId} className="block text-sm font-medium text-foreground">
        {t('agentReviewNote')}
      </label>
      <textarea
        id={noteId}
        name="reviewNote"
        rows={3}
        maxLength={4000}
        placeholder={approving ? t('agentApprovalNotePlaceholder') : t('agentRejectionNotePlaceholder')}
        className="ui-input h-auto min-h-24 resize-y py-2.5"
      />
      {approving ? (
        <label className="flex items-start gap-2 rounded-md border border-border bg-background/70 p-3 text-xs leading-5 text-foreground">
          <input
            type="checkbox"
            name="reviewConfirmed"
            value="yes"
            required
            className="mt-0.5 size-4 shrink-0 accent-brand"
          />
          <span>{t('agentReviewConfirm')}</span>
        </label>
      ) : null}
      <SubmitButton
        error={state.error}
        flash={false}
        pendingLabel={approving ? t('agentApprovingRelease') : t('agentRejectingRelease')}
        className={`h-11 w-full ${approving ? 'ui-button-primary' : 'ui-button-primary ui-button-danger'}`}
      >
        {approving ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
        {approving ? t('agentApproveRelease') : t('agentRejectRelease')}
      </SubmitButton>
      {state.error ? <p role="alert" className="text-sm text-destructive-text">{state.error}</p> : null}
      {state.ok ? <p role="status" className="text-sm text-accent-foreground">{t('saved')}</p> : null}
    </form>
  );
}

export function AgentReleaseReviewActions({
  listingId,
  releaseId,
  allowApprove = true,
}: {
  listingId: string;
  releaseId: string;
  allowApprove?: boolean;
}) {
  const t = useTranslations('admin');
  return (
    <div className={`grid content-start gap-5 ${allowApprove ? 'sm:grid-cols-2 xl:grid-cols-1' : ''}`}>
      {allowApprove ? (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
          <h3 className="text-sm font-semibold text-foreground">{t('agentApproveRelease')}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('agentApproveReleaseDescription')}</p>
          <div className="mt-4">
            <ReviewActionForm listingId={listingId} releaseId={releaseId} tone="approve" />
          </div>
        </div>
      ) : null}
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4">
        <h3 className="text-sm font-semibold text-foreground">{t('agentRejectRelease')}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('agentRejectReleaseDescription')}</p>
        <div className="mt-4">
          <ReviewActionForm listingId={listingId} releaseId={releaseId} tone="reject" />
        </div>
      </div>
    </div>
  );
}
