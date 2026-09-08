import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Activity, ChevronRight, ShieldCheck } from 'lucide-react';
import { adminHref, adminReturnHref } from '@/lib/admin/navigation';
import { requireAdmin } from '@/lib/auth/admin';
import { getUserDetail } from '@/lib/admin/users';
import { setUserRoleAction, setUserStatusAction, deleteUserAction } from '@/lib/admin/user-actions';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { AdminBadge, AdminPage, AdminPageHeader, AdminPanel } from '@/components/admin/AdminUI';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';

export const dynamic = 'force-dynamic';

export default async function AdminUserDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ returnTo?: string }> }) {
  const [t, locale] = await Promise.all([getTranslations('admin'), getLocale()]);
  const admin = await requireAdmin();
  const timeZone = resolveUserTimeZone(admin);
  const { id } = await params;
  const u = await getUserDetail(id);
  if (!u) notFound();
  const isSelf = admin.id === u.id;
  const ops = await getTranslations('adminOps');
  const backHref = adminReturnHref((await searchParams).returnTo, '/admin/users');
  const selfHref = adminHref(`/admin/users/${id}`, { returnTo: backHref });
  const joined = u.memberships.filter(({ workspace }) => !u.ownedWorkspaces.some((owned) => owned.id === workspace.id));
  const impact = u.ownedWorkspaces.reduce((sum, workspace) => ({ deployments: sum.deployments + workspace._count.deployments, agents: sum.agents + workspace._count.agents, sandboxes: sum.sandboxes + workspace._count.sandboxes }), { deployments: 0, agents: 0, sandboxes: 0 });
  const joinedAt = formatInTimeZone(u.createdAt, timeZone, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }, locale);

  return (
    <AdminPage className="max-w-5xl">
      <AdminPageHeader
        title={u.name ?? u.email}
        description={`${u.email} ${t('joined')} ${joinedAt}`}
        backHref={backHref}
        backLabel={t('users1')}
        actions={<>
          <Link href={adminHref('/admin/logs', { domain: 'all', actorId: id, returnTo: selfHref })} className="ui-button-secondary"><Activity className="size-4" />{ops('activity')}</Link>
          <Link href={adminHref('/admin/logs', { tab: 'audit', targetType: 'user', targetId: id, returnTo: selfHref })} className="ui-button-secondary"><ShieldCheck className="size-4" />{ops('audit')}</Link>
        </>}
        meta={(
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <AdminBadge tone={u.role === 'admin' ? 'brand' : 'neutral'}>
              {u.role === 'admin' ? t('admin2') : t('user')}
            </AdminBadge>
            <AdminBadge tone={u.status === 'suspended' ? 'warning' : 'success'} dot>
              {u.status === 'suspended' ? t('suspended2') : t('active')}
            </AdminBadge>
          </span>
        )}
      />

      <AdminPanel title={t('access')}>
        {isSelf ? (
          <p className="text-sm text-muted-foreground">{t('youCanapostChangeYourOwnRoleOrStatus')}</p>
        ) : (
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:flex-wrap">
            <ConfirmDialog
              label={u.role === 'admin' ? t('demoteToUser') : t('promoteToAdmin')}
              prompt={u.role === 'admin' ? t('removeAdmin') : t('grantAdmin')}
              action={setUserRoleAction}
              hidden={{ userId: u.id, role: u.role === 'admin' ? 'user' : 'admin' }}
              pendingLabel={t('saving')}
            />
            <ConfirmDialog
              label={u.status === 'suspended' ? t('reactivate') : t('suspend')}
              prompt={u.status === 'suspended' ? t('reactivateThisAccount') : t('suspendThisAccount')}
              action={setUserStatusAction}
              hidden={{ userId: u.id, status: u.status === 'suspended' ? 'active' : 'suspended' }}
              pendingLabel={t('saving')}
              tone={u.status === 'suspended' ? 'default' : 'danger'}
            />
          </div>
        )}
      </AdminPanel>

      <AdminPanel
        title={t('ownedWorkspaces')}
        actions={<AdminBadge tone="neutral">{u.ownedWorkspaces.length}</AdminBadge>}
        padded={false}
      >
        {u.ownedWorkspaces.length > 0 ? (
          <ul className="divide-y divide-border">
            {u.ownedWorkspaces.map((w) => (
              <li key={w.id}>
                <Link
                  href={adminHref(`/admin/workspaces/${w.id}`, { returnTo: selfHref })}
                  className="group flex min-h-14 min-w-0 items-center justify-between gap-3 px-5 py-2.5 transition-colors hover:bg-muted/55"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-foreground">{w.name}</span>
                    <code className="block truncate font-mono text-xs text-muted-foreground">/{w.slug}</code>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">{t('none')}</p>
        )}
      </AdminPanel>

      <AdminPanel title={ops('joinedWorkspaces')} actions={<AdminBadge>{joined.length}</AdminBadge>} padded={false}>
        {joined.length ? <ul className="divide-y divide-border">{joined.map(({ workspace, role }) => <li key={workspace.id}>
          <Link href={adminHref(`/admin/workspaces/${workspace.id}`, { returnTo: selfHref })} className="flex min-h-14 items-center justify-between gap-3 px-5 py-3 hover:bg-muted/55">
            <span className="min-w-0"><span className="block truncate text-sm font-medium">{workspace.name}</span><code className="text-xs text-muted-foreground">/{workspace.slug}</code></span><AdminBadge>{role === 'owner' ? t('workspaceRoleOwner') : t('workspaceRoleMember')}</AdminBadge>
          </Link>
        </li>)}</ul> : <p className="px-5 py-6 text-sm text-muted-foreground">{t('none')}</p>}
      </AdminPanel>

      {!isSelf ? (
        <AdminPanel
          title={t('dangerZone')}
          description={t('deletingCascadesToAllOwnedWorkspacesDeploymentsAndAgents')}
          tone="danger"
        >
          <p className="mb-2 text-sm">{ops('impact', { workspaces: u.ownedWorkspaces.length, ...impact })}</p>
          <p className="mb-4 text-sm text-muted-foreground">{ops('tokenImpact', { count: u._count.apiTokens })}</p>
          <ConfirmDialog
            label={t('deleteUser')}
            prompt={t('typeToConfirm', { value: u.email })}
            action={deleteUserAction}
            hidden={{ userId: u.id, email: u.email }}
            confirmWord={u.email}
            pendingLabel={t('deleting')}
            tone="danger"
          />
        </AdminPanel>
      ) : null}
    </AdminPage>
  );
}
