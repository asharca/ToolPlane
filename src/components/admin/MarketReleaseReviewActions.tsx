'use client';

import { CheckCircle2, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useId } from 'react';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import {
  approveMarketReleaseAction,
  rejectMarketReleaseAction,
} from '@/lib/admin/market-review-actions';
import type { AdminActionState } from '@/lib/admin/user-actions';

export function MarketReleaseReviewActions({
  listingId,
  releaseId,
  categories,
  selectedCategoryIds,
}: {
  listingId: string;
  releaseId: string;
  categories: Array<{ id: string; name: string }>;
  selectedCategoryIds: string[];
}) {
  const t = useTranslations('admin');
  const noteId = useId();
  const [approveState, approveAction] = useActionState<AdminActionState, FormData>(
    approveMarketReleaseAction,
    {},
  );
  const [rejectState, rejectAction] = useActionState<AdminActionState, FormData>(
    rejectMarketReleaseAction,
    {},
  );
  const error = approveState.error ?? rejectState.error;
  const selected = new Set(selectedCategoryIds);

  return (
    <div className="space-y-3 lg:w-80">
      <form action={approveAction} className="space-y-3">
        <input type="hidden" name="listingId" value={listingId} />
        <input type="hidden" name="releaseId" value={releaseId} />
        <fieldset>
          <legend className="text-xs font-semibold text-muted-foreground">{t('categories')}</legend>
          <div className="mt-2 grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-1">
            {categories.map((category) => (
              <label key={category.id} className="flex min-h-9 items-center gap-2 rounded px-2 text-sm text-foreground hover:bg-muted/60">
                <input
                  type="checkbox"
                  name="categoryIds"
                  value={category.id}
                  defaultChecked={selected.has(category.id)}
                  className="size-4 accent-brand"
                />
                <span className="truncate">{category.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex items-start gap-2 border border-border bg-background/70 p-3 text-xs leading-5 text-foreground">
          <input
            type="checkbox"
            name="reviewConfirmed"
            value="yes"
            required
            className="mt-0.5 size-4 shrink-0 accent-brand"
          />
          <span>{t('marketReleaseReviewConfirm')}</span>
        </label>
        <SubmitButton
          error={approveState.error}
          flash={false}
          pendingLabel={t('agentApprovingRelease')}
          className="ui-button-primary h-10 w-full"
        >
          <CheckCircle2 className="size-4" />
          {t('agentApproveRelease')}
        </SubmitButton>
      </form>

      <form action={rejectAction} className="space-y-2">
        <input type="hidden" name="listingId" value={listingId} />
        <input type="hidden" name="releaseId" value={releaseId} />
        <label htmlFor={noteId} className="sr-only">{t('agentReviewNote')}</label>
        <textarea
          id={noteId}
          name="reviewNote"
          rows={2}
          maxLength={4000}
          placeholder={t('agentRejectionNotePlaceholder')}
          className="ui-input h-auto resize-y py-2.5 text-sm"
        />
        <SubmitButton
          flash={false}
          pendingLabel={t('agentRejectingRelease')}
          className="ui-button-primary ui-button-danger h-10 w-full"
        >
          <XCircle className="size-4" />
          {t('agentRejectRelease')}
        </SubmitButton>
      </form>

      {error ? <p role="alert" className="text-sm text-destructive-text">{error}</p> : null}
    </div>
  );
}
