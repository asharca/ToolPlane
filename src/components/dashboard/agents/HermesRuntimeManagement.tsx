'use client';

import { useTranslations } from 'next-intl';
import {
  renameSandboxAction,
  updateSandboxEnvAction,
  updateSandboxSudoAction,
} from '@/lib/sandboxes/actions';
import {
  SandboxDataManagement,
  type SandboxSnapshotItem,
} from '@/components/dashboard/sandboxes/SandboxDataManagement';
import { SubmitButton } from '@/components/dashboard/SubmitButton';

export type HermesRuntimeManagementData = {
  workspace: string;
  sandboxId: string;
  sandboxName: string;
  environment: string;
  allowSudo: boolean;
  status: string;
  snapshots: SandboxSnapshotItem[];
};

const LIFECYCLE_BLOCKED_STATUSES = new Set([
  'copying',
  'copy_failed',
  'restoring',
  'restore_failed',
  'restore_cleanup_required',
  'upgrading',
  'deleting',
]);

export function HermesRuntimeManagement({
  workspace,
  sandboxId,
  sandboxName,
  environment,
  allowSudo,
  status,
  snapshots,
}: HermesRuntimeManagementData) {
  const t = useTranslations('console.sandboxes');
  const agents = useTranslations('console.agents');
  const lifecycleBlocked = LIFECYCLE_BLOCKED_STATUSES.has(status);
  const dataManagementVisible = status !== 'copy_failed' && status !== 'deleting';

  return (
    <div className="mx-auto w-full max-w-3xl divide-y divide-border px-4 py-5 sm:px-5">
      <section className="pb-5">
        <h3 className="text-sm font-semibold text-foreground">{t('generalSettings')}</h3>
        <form action={renameSandboxAction} className="mt-3">
          <input type="hidden" name="workspace" value={workspace} />
          <input type="hidden" name="sandboxId" value={sandboxId} />
          <fieldset disabled={lifecycleBlocked} className="flex items-end gap-2 disabled:opacity-60">
            <label className="min-w-0 flex-1 space-y-1.5 text-xs font-medium text-muted-foreground">
              {t('sandboxName')}
              <input
                name="name"
                defaultValue={sandboxName}
                maxLength={80}
                className="ui-input h-9 min-w-0 text-sm"
              />
            </label>
            <SubmitButton pendingLabel={t('renaming')} className="ui-button-secondary h-9 text-xs">
              {t('rename')}
            </SubmitButton>
          </fieldset>
        </form>
      </section>

      <section className="py-5">
        <h3 className="text-sm font-semibold text-foreground">{agents('hermesEnvironmentVariables')}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{agents('hermesEnvironmentHelp')}</p>
        <form action={updateSandboxEnvAction} className="mt-3">
          <input type="hidden" name="workspace" value={workspace} />
          <input type="hidden" name="sandboxId" value={sandboxId} />
          <fieldset disabled={lifecycleBlocked} className="space-y-3 disabled:opacity-60">
            <textarea
              name="env"
              defaultValue={environment}
              rows={6}
              spellCheck={false}
              placeholder={agents('hermesEnvPlaceholder')}
              className="ui-input min-h-32 w-full resize-y font-mono text-xs leading-5"
              aria-label={agents('hermesEnvironmentVariables')}
            />
            <div className="flex flex-wrap items-center justify-end gap-3">
              <SubmitButton pendingLabel={agents('savingAndSyncingEnvironment')} className="ui-button-secondary h-8 text-xs">
                {agents('saveEnvironment')}
              </SubmitButton>
            </div>
          </fieldset>
        </form>
      </section>

      <section className="py-5">
        <h3 className="text-sm font-semibold text-foreground">{t('allowSudoTitle')}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('allowSudoDescription')}</p>
        <form action={updateSandboxSudoAction} className="mt-3">
          <input type="hidden" name="workspace" value={workspace} />
          <input type="hidden" name="sandboxId" value={sandboxId} />
          <fieldset disabled={lifecycleBlocked} className="space-y-3 disabled:opacity-60">
            <label className="flex items-start gap-2 rounded-md border border-border bg-background px-3 py-3 text-xs leading-5 text-foreground">
              <input
                type="checkbox"
                name="allowSudo"
                defaultChecked={allowSudo}
                className="mt-0.5 size-3.5 shrink-0 accent-brand"
              />
              {t('allowSudo')}
            </label>
            <div className="flex flex-wrap items-center justify-end gap-3">
              <SubmitButton pendingLabel={t('saving')} className="ui-button-secondary h-8 text-xs">
                {t('saveAllowSudo')}
              </SubmitButton>
            </div>
          </fieldset>
        </form>
      </section>

      {dataManagementVisible ? (
        <SandboxDataManagement
          workspace={workspace}
          sandboxId={sandboxId}
          sandboxName={sandboxName}
          snapshots={snapshots}
          disabled={status === 'provisioning'
            || status === 'copying'
            || status === 'restoring'
            || status === 'restore_cleanup_required'
            || status === 'upgrading'}
          disabledLabel={status === 'restore_cleanup_required' ? t('statusCleanupPending') : undefined}
          creationDisabled={status === 'restore_failed'}
          mode="hermes"
          showClone={false}
        />
      ) : null}
    </div>
  );
}
