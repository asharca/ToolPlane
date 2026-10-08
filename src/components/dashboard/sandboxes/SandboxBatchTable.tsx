'use client';

import { useOptimistic, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/motion/button';
import { ConfirmSubmitButton } from '@/components/dashboard/ConfirmSubmitButton';
import { DashboardTable, type DashboardTableProps, type DashboardTableRow } from '@/components/dashboard/DashboardTable';
import { batchSandboxLifecycleAction, type SandboxLifecycleBatchResult } from '@/lib/sandboxes/actions';

type Operation = 'start' | 'stop' | 'restart';
type BatchResult = SandboxLifecycleBatchResult & { name: string };
type SandboxRow = DashboardTableRow & { name: string; batchEligible: boolean };

export function SandboxBatchTable({ workspace, rows, ...tableProps }: Omit<DashboardTableProps, 'rows' | 'selectedRowIds' | 'onSelectionChange' | 'selectionActions'> & {
  workspace: string;
  rows: SandboxRow[];
}) {
  const t = useTranslations('console.sandboxes');
  const common = useTranslations('common');
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [operation, setOperation] = useOptimistic<Operation | null>(null);
  const [lastOperation, setLastOperation] = useState<Operation>('start');
  const [results, setResults] = useState<BatchResult[]>([]);
  const [selectionLimitReached, setSelectionLimitReached] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const submitting = useRef(false);
  const pending = operation !== null || refreshing;
  const eligibleIds = rows.filter((row) => row.batchEligible).map((row) => row.id);
  const eligible = new Set(eligibleIds);
  const visibleSelection = selectedIds.filter((id) => eligible.has(id));

  async function run(nextOperation: Operation, ids: string[]) {
    if (submitting.current || pending || ids.length === 0 || ids.length > 100) return;
    submitting.current = true;
    setOperation(nextOperation);
    setLastOperation(nextOperation);
    setResults([]);
    const names = new Map(rows.map((row) => [row.id, row.name]));
    try {
      const outcomes = await batchSandboxLifecycleAction(workspace, nextOperation, ids);
      setResults(outcomes.map((result) => ({ ...result, name: names.get(result.sandboxId) ?? result.sandboxId })));
    } catch {
      setResults(ids.map((sandboxId) => ({ sandboxId, name: names.get(sandboxId) ?? sandboxId, outcome: 'error', message: 'request_failed' })));
    } finally {
      setOperation(null);
      submitting.current = false;
      startRefresh(() => router.refresh());
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={pending || eligibleIds.length === 0 || eligibleIds.length > 100} onClick={() => { setSelectedIds(eligibleIds); setSelectionLimitReached(false); }}>
          {t('batchSelectAllEligible', { count: eligibleIds.length })}
        </Button>
        {eligibleIds.length < rows.length ? <p className="text-xs text-muted-foreground">{t('batchIneligibleHint')}</p> : null}
        {eligibleIds.length > 100 || selectionLimitReached ? <p role="status" className="text-xs text-muted-foreground">{t('batchSelectionLimit', { count: 100 })}</p> : null}
      </div>
      <fieldset disabled={pending} className="min-w-0" aria-busy={pending}>
        <legend className="sr-only">{t('sandboxes')}</legend>
        <DashboardTable
          {...tableProps}
          rows={rows}
          selectedRowIds={visibleSelection}
          onSelectionChange={(ids) => {
            if (pending) return;
            const next = ids.filter((id) => eligible.has(id));
            setSelectionLimitReached(next.length > 100);
            if (next.length <= 100) setSelectedIds(next);
          }}
          selectionActions={({ selectedRowIds }) => (
            <>
              <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => startRefresh(async () => { await run('start', selectedRowIds); })}>{t('batchStart')}</Button>
              {(['stop', 'restart'] as const).map((action) => (
                <form key={action} action={async () => { await run(action, selectedRowIds); }}>
                  <ConfirmSubmitButton
                    triggerLabel={t(action === 'stop' ? 'batchStop' : 'batchRestart')}
                    confirmLabel={common('confirm')}
                    cancelLabel={common('cancel')}
                    prompt={t(action === 'stop' ? 'batchStopPrompt' : 'batchRestartPrompt', { count: selectedRowIds.length })}
                    pendingLabel={t(action === 'stop' ? 'stopping' : 'restarting')}
                    disabled={pending}
                    triggerSize="sm"
                    confirmSize="sm"
                    cancelSize="sm"
                    promptClassName="text-xs text-muted-foreground"
                  />
                </form>
              ))}
            </>
          )}
        />
      </fieldset>
      <div role="status" aria-live="polite" aria-atomic="true" className="text-sm text-muted-foreground">
        {operation ? t(operation === 'start' ? 'starting' : operation === 'stop' ? 'stopping' : 'restarting') : results.length > 0 ? t('batchSummary', {
          operation: t(lastOperation),
          success: results.filter((result) => result.outcome === 'success').length,
          skipped: results.filter((result) => result.outcome === 'skipped').length,
          error: results.filter((result) => result.outcome === 'error').length,
        }) : null}
      </div>
      {results.length > 0 ? (
        <div className="space-y-2" aria-label={t('batchResults')}>
          <h3 className="text-sm font-medium">{t('batchResults')}</h3>
          <ul className="space-y-1 text-sm">
            {results.map((result) => (
              <li key={result.sandboxId} className="break-words">
                <span className="font-medium">{result.name}</span>{' — '}
                <span className={result.outcome === 'error' ? 'text-destructive' : 'text-muted-foreground'}>{t(`batchOutcome.${result.outcome}`)}: {t.has(`batchMessage.${result.message}`) ? t(`batchMessage.${result.message}`) : result.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
