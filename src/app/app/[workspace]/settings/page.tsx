import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { SettingsTabs } from '@/components/dashboard/SettingsTabs';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import {
  renameWorkspaceAction,
  deleteWorkspaceAction,
} from '@/lib/workspace/actions';

export const dynamic = 'force-dynamic';

const field =
  'h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const t = await getTranslations('console.settings');
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const isOwner = ws.ownerId === user.id;

  return (
    <>
      <DashboardHeader title={t('title')} />
      <div className="max-w-2xl space-y-8 px-8 py-6">
        <SettingsTabs slug={slug} />

        <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
          <div className="border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {t('general')}
            </h2>
          </div>
          <form action={renameWorkspaceAction} className="space-y-4 px-5 py-5">
            <input type="hidden" name="workspace" value={slug} />
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {t('orgName')}
              </label>
              <input name="name" defaultValue={ws.name} className={field} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {t('urlSlug')}
              </label>
              <div className="flex items-center rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/60">
                <span className="px-3 text-sm text-muted-foreground">mcpmarket.com/</span>
                <input
                  defaultValue={ws.slug}
                  readOnly
                  className="h-9 flex-1 rounded-r-md bg-transparent pr-3 text-sm text-zinc-500 outline-none dark:text-zinc-400"
                />
              </div>
            </div>
            <SubmitButton className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200">
              {t('saveChanges')}
            </SubmitButton>
          </form>
        </section>

        <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
          <div className="border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {t('timezone')}
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              {t('timezoneScheduled')}
            </p>
          </div>
          <div className="px-5 py-4">
            <div className="inline-flex h-9 items-center rounded-md border border-zinc-200 bg-zinc-50 px-3 text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-300">
              {Intl.DateTimeFormat().resolvedOptions().timeZone}
            </div>
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              {t('timezoneDesc')}
            </p>
          </div>
        </section>

        {isOwner ? (
          <section className="rounded-lg border border-red-200 dark:border-red-500/30">
            <div className="border-b border-red-100 px-5 py-4 dark:border-red-500/20">
              <h2 className="text-sm font-semibold text-red-700 dark:text-red-400">
                {t('dangerZone')}
              </h2>
            </div>
            <div className="px-5 py-4">
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {t('deleteOrg')}
              </p>
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                {t('deleteOrgDesc')}
              </p>
              <form action={deleteWorkspaceAction} className="mt-3">
                <input type="hidden" name="workspace" value={slug} />
                <button className="inline-flex h-9 items-center rounded-md border border-red-300 px-3 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/40 dark:text-red-400 dark:hover:bg-red-500/10">
                  {t('deleteOrgButton')}
                </button>
              </form>
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}
