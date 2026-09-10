import Link from 'next/link';
import { cookies } from 'next/headers';
import { getMessages, getTranslations } from 'next-intl/server';
import { NextIntlClientProvider } from 'next-intl';
import { ArrowRight, Layers3 } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getDefaultWorkspace, listWorkspacesForUser } from '@/lib/workspace/queries';
import { ACCOUNT_SETTINGS_HREF, WORKSPACE_MANAGER_HREF, lastWorkspaceCookieName, workspaceInitials } from '@/lib/workspace/navigation';
import { UserTimeZoneProvider } from '@/components/timezone/UserTimeZoneProvider';
import { DashboardPanel } from './DashboardUI';
import { DashboardLogo } from './DashboardLogo';
import { AccountMenu } from './AccountMenu';
import { PersonalSettingsContent } from './PersonalSettingsContent';
import { CreateWorkspaceForm, WorkspaceDeleteForm, WorkspaceMemberAction } from './WorkspaceForms';

export type WorkspaceAccountUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

export async function WorkspaceAccountPage({ user, view = 'workspaces', intent = '', notice = '' }: {
  user: WorkspaceAccountUser; view?: 'workspaces' | 'account'; intent?: string; notice?: string;
}) {
  const [t, messages, cookieStore] = await Promise.all([
    getTranslations('console.workspaces'), getMessages(), cookies(),
  ]);
  const lastWorkspace = await getDefaultWorkspace(user.id, cookieStore.get(lastWorkspaceCookieName(user.id))?.value);
  const workspaces = view === 'workspaces' ? await listWorkspacesForUser(user.id) : [];

  return (
    <NextIntlClientProvider messages={{ common: messages.common, console: messages.console, auth: messages.auth }}>
      <UserTimeZoneProvider detectedTimeZone={user.detectedTimeZone} timeZoneOverride={user.timeZoneOverride}>
        <div className="min-h-dvh bg-shell text-foreground">
          <header className="border-b border-border bg-background/80">
            <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-8">
              <DashboardLogo />
              <div className="flex min-w-0 items-center gap-3">
                {lastWorkspace ? <Link href={`/app/${lastWorkspace.slug}/chat`} className="ui-button-ghost hidden sm:inline-flex">{t('backToWorkspace')}<ArrowRight className="size-4" /></Link> : null}
                <div className="max-w-52"><AccountMenu userLabel={user.name ?? user.email} workspaceSlug={lastWorkspace?.slug} returnTo={WORKSPACE_MANAGER_HREF} isAdmin={user.role === 'admin'} /></div>
              </div>
            </div>
          </header>
          <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8 sm:py-10">
            {view === 'account' ? (
              <nav aria-label={t('accountNavigation')} className="flex gap-2">
                <Link href={ACCOUNT_SETTINGS_HREF} aria-current="page" className="ui-button-secondary">{t('account')}</Link>
              </nav>
            ) : null}

            {view === 'account' ? <PersonalSettingsContent user={user} workspaceSlug={lastWorkspace?.slug} returnTo={WORKSPACE_MANAGER_HREF} /> : (
              <>
                <div><h1 className="text-2xl font-semibold">{intent ? t('chooseWorkspace') : t('title')}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{intent ? t('chooseHint') : t('sharedHint')}</p></div>
                {['left', 'deleted', 'unavailable'].includes(notice) ? <p role="status" className="rounded-lg border border-border bg-background p-3 text-sm">{t(`notice.${notice}`)}</p> : null}
                <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
                  <section aria-label={t('title')} className="space-y-3">
                    {!workspaces.length ? <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center"><Layers3 className="mx-auto mb-3 size-8 text-muted-foreground" /><h2 className="font-medium">{t('emptyTitle')}</h2><p className="mt-2 text-sm text-muted-foreground">{t('emptyHint')}</p></div> : null}
                    {workspaces.map((workspace) => (
                      <article key={workspace.id} className="rounded-xl border border-border bg-background p-4 sm:p-5">
                        <div className="flex items-start gap-3">
                          <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-sm font-semibold">{workspaceInitials(workspace.name)}</span>
                          <div className="min-w-0 flex-1">
                            <h2 className="break-words font-semibold">{workspace.name}</h2>
                            <p className="mt-1 text-xs text-muted-foreground">{t(workspace.role)} · {t('memberCount', { count: workspace.memberCount })}{lastWorkspace?.id === workspace.id ? ` · ${t('recent')}` : ''}</p>
                          </div>
                          {workspace.status === 'active' ? <Link href={intent ? `${intent}&workspace=${encodeURIComponent(workspace.slug)}` : `/app/${workspace.slug}/chat`} className="ui-button-secondary shrink-0" aria-label={t('enterNamed', { name: workspace.name })}>{t('enter')}<ArrowRight className="size-4" /></Link> : null}
                        </div>
                        {workspace.status === 'active' ? (
                          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                            <Link href={`/app/${workspace.slug}/members`} className="ui-button-ghost ui-button-sm">{t('members')}</Link>
                            {workspace.role === 'member' ? <WorkspaceMemberAction slug={workspace.slug} kind="leave" /> : null}
                          </div>
                        ) : <div className="mt-4 space-y-3 border-t border-border pt-3"><p role="status" className="text-sm text-destructive">{t(workspace.status === 'delete_failed' ? 'errors.deleteFailed' : 'cleanupPending')}</p>{workspace.role === 'owner' ? <WorkspaceDeleteForm slug={workspace.slug} name={workspace.name} status={workspace.status} /> : <WorkspaceMemberAction slug={workspace.slug} kind="leave" />}</div>}
                      </article>
                    ))}
                  </section>
                  <DashboardPanel title={t('create')} description={t('createDescription')}><CreateWorkspaceForm intent={intent} /></DashboardPanel>
                </div>
              </>
            )}
          </main>
        </div>
      </UserTimeZoneProvider>
    </NextIntlClientProvider>
  );
}
