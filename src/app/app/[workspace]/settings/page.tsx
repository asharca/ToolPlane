import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { SettingsTabs } from '@/components/dashboard/SettingsTabs';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { ConfirmSubmitButton } from '@/components/dashboard/ConfirmSubmitButton';
import { LocaleSwitcher } from '@/components/layout/LocaleSwitcher';
import {
  DashboardPage,
  DashboardPanel,
} from '@/components/dashboard/DashboardUI';
import {
  renameWorkspaceAction,
  deleteWorkspaceAction,
} from '@/lib/workspace/actions';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const t = await getTranslations('console.settings');
  const common = await getTranslations('common');
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const isOwner = ws.ownerId === user.id;

  return (
    <>
      <DashboardHeader title={t('title')} />
      <DashboardPage className="max-w-2xl">
        <SettingsTabs slug={slug} />

        <DashboardPanel title={t('general')}>
          <form action={renameWorkspaceAction} className="space-y-4">
            <input type="hidden" name="workspace" value={slug} />
            <div className="space-y-1.5">
              <label htmlFor="workspace-name" className="text-sm font-medium text-foreground">
                {t('orgName')}
              </label>
              <input
                id="workspace-name"
                name="name"
                defaultValue={ws.name}
                className="ui-input h-9"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="workspace-slug" className="text-sm font-medium text-foreground">
                {t('urlSlug')}
              </label>
              <div className="flex items-center rounded-md border border-border bg-muted/60">
                <span className="px-3 text-sm text-muted-foreground">{t('toolplanelocal')}</span>
                <input
                  id="workspace-slug"
                  defaultValue={ws.slug}
                  readOnly
                  className="h-9 flex-1 rounded-r-md bg-transparent pr-3 text-sm text-muted-foreground outline-none"
                />
              </div>
            </div>
            <SubmitButton className="ui-button-primary">
              {t('saveChanges')}
            </SubmitButton>
          </form>
        </DashboardPanel>

        <DashboardPanel
          title={t('preferences')}
          description={t('preferencesDesc')}
          bodyClassName="py-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">
                {t('language')}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('languageDesc')}
              </p>
            </div>
            <LocaleSwitcher />
          </div>
        </DashboardPanel>

        <DashboardPanel
          title={t('timezone')}
          description={t('timezoneScheduled')}
          bodyClassName="py-4"
        >
          <div className="inline-flex h-9 items-center rounded-md border border-border bg-muted/60 px-3 text-sm text-foreground">
            {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t('timezoneDesc')}
          </p>
        </DashboardPanel>

        {isOwner ? (
          <DashboardPanel title={t('dangerZone')} tone="danger" bodyClassName="py-4">
            <p className="text-sm font-medium text-foreground">
              {t('deleteOrg')}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('deleteOrgDesc')}
            </p>
            <form action={deleteWorkspaceAction} className="mt-3">
              <input type="hidden" name="workspace" value={slug} />
              <ConfirmSubmitButton
                triggerLabel={t('deleteOrgButton')}
                confirmLabel={common('confirm')}
                cancelLabel={common('cancel')}
                prompt={`${t('deleteOrg')}?`}
                pendingLabel={`${common('confirm')}…`}
                className="max-w-xl items-start"
                triggerClassName="inline-flex h-9 items-center rounded-md border border-red-300 px-3 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/40 dark:text-red-400 dark:hover:bg-red-500/10"
                confirmClassName="inline-flex h-9 items-center rounded-md bg-red-600 px-3 text-sm font-medium text-white transition-colors hover:bg-red-700"
                cancelClassName="ui-button-secondary h-9"
              />
            </form>
          </DashboardPanel>
        ) : null}
      </DashboardPage>
    </>
  );
}
