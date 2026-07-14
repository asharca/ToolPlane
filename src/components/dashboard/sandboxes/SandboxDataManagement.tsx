'use client';

import { Camera, Copy, RotateCcw, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  cloneSandboxAction,
  createSandboxSnapshotAction,
  deleteSandboxSnapshotAction,
  restoreSandboxSnapshotAction,
} from '@/lib/sandboxes/actions';
import { ConfirmSubmitButton } from '@/components/dashboard/ConfirmSubmitButton';
import { SubmitButton } from '@/components/dashboard/SubmitButton';

type SnapshotItem = {
  id: string;
  name: string;
  status: string;
  error: string | null;
  createdAt: string;
};

function SnapshotStatus({ status }: { status: string }) {
  const t = useTranslations('console.sandboxes');
  const styles = status === 'ready'
    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    : status === 'error'
      ? 'bg-red-500/10 text-red-700 dark:text-red-300'
      : 'bg-amber-500/10 text-amber-700 dark:text-amber-300';
  const label = status === 'ready'
    ? t('snapshotReady')
    : status === 'error'
      ? t('snapshotError')
      : status === 'deleting'
        ? t('snapshotDeleting')
        : t('snapshotCreating');

  return <span className={`rounded-md px-2 py-1 text-[11px] font-medium ${styles}`}>{label}</span>;
}

export function SandboxDataManagement({
  workspace,
  sandboxId,
  sandboxName,
  snapshots,
  disabled = false,
  disabledLabel,
  creationDisabled = false,
}: {
  workspace: string;
  sandboxId: string;
  sandboxName: string;
  snapshots: SnapshotItem[];
  disabled?: boolean;
  disabledLabel?: string;
  creationDisabled?: boolean;
}) {
  const t = useTranslations('console.sandboxes');
  const common = useTranslations('common');

  return (
    <section className="py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('workspaceData')}</h3>
          <p className="mt-0.5 max-w-2xl text-xs leading-5 text-muted-foreground">
            {t('workspaceDataDescription')}
          </p>
        </div>
        {disabled ? (
          <span className="rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
            {disabledLabel ?? t('waitForProvisioning')}
          </span>
        ) : creationDisabled ? (
          <span className="rounded-md bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-300">
            {t('restoreRequired')}
          </span>
        ) : null}
      </div>

      <div className="mt-4 space-y-5">
        <fieldset disabled={disabled || creationDisabled} className="disabled:opacity-60">
          <div className="grid gap-4 lg:grid-cols-2">
            <form action={cloneSandboxAction} className="space-y-2">
              <input type="hidden" name="workspace" value={workspace} />
              <input type="hidden" name="sandboxId" value={sandboxId} />
              <input type="hidden" name="defaultName" value={t('cloneNameDefault', { name: sandboxName })} />
              <label className="block text-xs font-medium text-muted-foreground" htmlFor="sandbox-clone-name">
                {t('cloneName')}
              </label>
              <div className="flex gap-2">
                <input
                  id="sandbox-clone-name"
                  name="name"
                  defaultValue={t('cloneNameDefault', { name: sandboxName })}
                  maxLength={80}
                  className="ui-input h-9 min-w-0 flex-1 text-sm"
                />
                <SubmitButton flash={false} pendingLabel={t('cloning')} className="ui-button-secondary h-9 shrink-0 text-xs">
                  <Copy className="size-3.5" />
                  {t('cloneSandbox')}
                </SubmitButton>
              </div>
            </form>

            <form action={createSandboxSnapshotAction} className="space-y-2">
              <input type="hidden" name="workspace" value={workspace} />
              <input type="hidden" name="sandboxId" value={sandboxId} />
              <input type="hidden" name="defaultName" value={t('snapshotDefaultName')} />
              <label className="block text-xs font-medium text-muted-foreground" htmlFor="sandbox-snapshot-name">
                {t('snapshotName')}
              </label>
              <div className="flex gap-2">
                <input
                  id="sandbox-snapshot-name"
                  name="name"
                  placeholder={t('snapshotNamePlaceholder')}
                  maxLength={80}
                  className="ui-input h-9 min-w-0 flex-1 text-sm"
                />
                <SubmitButton flash={false} pendingLabel={t('creatingSnapshot')} className="ui-button-secondary h-9 shrink-0 text-xs">
                  <Camera className="size-3.5" />
                  {t('createSnapshot')}
                </SubmitButton>
              </div>
            </form>
          </div>
        </fieldset>

        <fieldset disabled={disabled} className="disabled:opacity-60">
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h4 className="text-xs font-semibold uppercase text-muted-foreground">{t('snapshots')}</h4>
              <span className="text-xs tabular-nums text-muted-foreground">{snapshots.length}</span>
            </div>
            {snapshots.length === 0 ? (
              <p className="border-t border-border py-4 text-xs text-muted-foreground">{t('noSnapshots')}</p>
            ) : (
            <ul className="divide-y divide-border border-y border-border">
              {snapshots.map((snapshot) => {
                const ready = snapshot.status === 'ready';
                return (
                  <li key={snapshot.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{snapshot.name}</span>
                        <SnapshotStatus status={snapshot.status} />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{snapshot.createdAt}</p>
                      {snapshot.error ? (
                        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t('snapshotOperationFailed')}</p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {ready ? (
                        <form action={restoreSandboxSnapshotAction}>
                          <input type="hidden" name="workspace" value={workspace} />
                          <input type="hidden" name="sandboxId" value={sandboxId} />
                          <input type="hidden" name="snapshotId" value={snapshot.id} />
                          <input
                            type="hidden"
                            name="recoveryName"
                            value={t('restoreRecoveryName', { name: snapshot.name })}
                          />
                          <ConfirmSubmitButton
                            triggerLabel={<><RotateCcw className="size-3.5" />{t('restoreSnapshot')}</>}
                            confirmLabel={common('confirm')}
                            cancelLabel={common('cancel')}
                            prompt={t('restoreSnapshotPrompt', { name: snapshot.name })}
                            pendingLabel={t('restoringSnapshot')}
                            triggerClassName="ui-button-ghost h-8 text-xs"
                            confirmClassName="ui-button-primary h-8 text-xs"
                            cancelClassName="ui-button-ghost h-8 text-xs"
                            promptClassName="max-w-56 text-xs text-muted-foreground"
                          />
                        </form>
                      ) : null}
                      <form action={deleteSandboxSnapshotAction}>
                        <input type="hidden" name="workspace" value={workspace} />
                        <input type="hidden" name="sandboxId" value={sandboxId} />
                        <input type="hidden" name="snapshotId" value={snapshot.id} />
                        <ConfirmSubmitButton
                          triggerLabel={<><Trash2 className="size-3.5" />{t('deleteSnapshot')}</>}
                          confirmLabel={common('confirm')}
                          cancelLabel={common('cancel')}
                          prompt={t('deleteSnapshotPrompt', { name: snapshot.name })}
                          pendingLabel={t('deletingSnapshot')}
                          triggerClassName="ui-button-ghost h-8 text-xs text-red-700 dark:text-red-400"
                          confirmClassName="ui-button-primary h-8 bg-red-600 text-xs text-white hover:bg-red-700"
                          cancelClassName="ui-button-ghost h-8 text-xs"
                          promptClassName="max-w-56 text-xs text-muted-foreground"
                        />
                      </form>
                    </div>
                  </li>
                );
              })}
            </ul>
            )}
          </div>
        </fieldset>
      </div>
    </section>
  );
}
