import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { SettingsModal } from '@/components/dashboard/SettingsModal';
import { SettingsTabs } from '@/components/dashboard/SettingsTabs';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { ConfirmSubmitButton } from '@/components/dashboard/ConfirmSubmitButton';
import { LocaleSwitcher } from '@/components/layout/LocaleSwitcher';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { TimeZoneSettings } from '@/components/timezone/TimeZoneSettings';
import { ChangePasswordForm } from '@/components/auth/PasswordRecoveryForms';
import {
  DashboardPanel,
} from '@/components/dashboard/DashboardUI';
import {
  renameWorkspaceAction,
  deleteWorkspaceAction,
} from '@/lib/workspace/actions';
import { originFromHeaders } from '@/lib/http/origin';

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
  const workspaceUrlPrefix = new URL('/app/', originFromHeaders(await headers())).toString();

  return (
    <SettingsModal title={t('title')} fallbackHref={`/app/${slug}/chat`}>
      <div className="flex h-full min-h-0 flex-col md:flex-row">
        <SettingsTabs slug={slug} />
        <div className="min-w-0 flex-1 overflow-y-auto p-5 sm:p-6 lg:p-8">
          <div className="space-y-6">

        <DashboardPanel title={t('general')}>
          <form action={renameWorkspaceAction} className="space-y-4">
            <input type="hidden" name="workspace" value={slug} />
            <div className="space-y-1.5">
              <label htmlFor="workspace-name" className="text-sm font-medium text-foreground">
                {t('workspaceName')}
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
                <span className="px-3 text-sm text-muted-foreground">{workspaceUrlPrefix}</span>
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
          <div className="divide-y divide-border">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
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
            <div className="flex items-center justify-between gap-3 pt-4">
              <p className="text-sm font-medium text-foreground">{common('toggleTheme')}</p>
              <ThemeToggle />
            </div>
          </div>
        </DashboardPanel>

        <DashboardPanel
          title={t('timezone')}
          description={t('timezoneScheduled')}
          bodyClassName="py-4"
        >
          <TimeZoneSettings timeZoneOverride={user.timeZoneOverride} />
          <p className="mt-2 text-xs text-muted-foreground">{t('timezoneDesc')}</p>
        </DashboardPanel>

        <DashboardPanel
          title={t('security')}
          description={t('passwordSettingsDesc')}
          bodyClassName="py-4"
        >
          <ChangePasswordForm />
        </DashboardPanel>

        {isOwner ? (
          <DashboardPanel title={t('dangerZone')} tone="danger" bodyClassName="py-4">
            <p className="text-sm font-medium text-foreground">
              {t('deleteWorkspace')}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('deleteWorkspaceDesc')}
            </p>
            <form action={deleteWorkspaceAction} className="mt-3">
              <input type="hidden" name="workspace" value={slug} />
              <ConfirmSubmitButton
                triggerLabel={t('deleteWorkspaceButton')}
                confirmLabel={common('confirm')}
                cancelLabel={common('cancel')}
                prompt={`${t('deleteWorkspace')}?`}
                pendingLabel={`${common('confirm')}…`}
                className="max-w-xl items-start"
                triggerClassName="inline-flex h-9 items-center rounded-md border border-red-300 px-3 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/40 dark:text-red-400 dark:hover:bg-red-500/10"
                confirmClassName="inline-flex h-9 items-center rounded-md bg-red-600 px-3 text-sm font-medium text-white transition-colors hover:bg-red-700"
                cancelClassName="ui-button-secondary h-9"
              />
            </form>
          </DashboardPanel>
        ) : null}
        </div>
        </div>
      </div>
    </SettingsModal>
  );
}
