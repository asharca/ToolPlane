import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Activity, ShieldCheck } from 'lucide-react';
import { adminHref, adminReturnHref } from '@/lib/admin/navigation';
import { LogOutcomeBadge, LogTimestamp } from '@/components/admin/LogUI';
import { requireAdmin } from '@/lib/auth/admin';
import { getWorkspaceDetail } from '@/lib/admin/workspaces';
import { deleteWorkspaceAdminAction } from '@/lib/admin/workspace-actions';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import {
  AdminBadge,
  AdminPage,
  AdminPageHeader,
  AdminPanel,
  type AdminBadgeTone,
} from '@/components/admin/AdminUI';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';

export const dynamic = 'force-dynamic';

function deploymentTone(status: string): AdminBadgeTone {
  if (status === 'running') return 'success';
  if (status === 'failed' || status === 'error') return 'danger';
  if (status === 'provisioning' || status === 'starting') return 'warning';
  return 'neutral';
}

export default async function AdminWorkspaceDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ returnTo?: string }> }) {
  const [t, locale] = await Promise.all([getTranslations('admin'), getLocale()]);
  const admin = await requireAdmin();
  const timeZone = resolveUserTimeZone(admin);
  const { id } = await params;
  const w = await getWorkspaceDetail(id);
  if (!w) notFound();
  const ops = await getTranslations('adminOps');
  const backHref = adminReturnHref((await searchParams).returnTo, '/admin/workspaces');
  const selfHref = adminHref(`/admin/workspaces/${id}`, { returnTo: backHref });
  const logsHref = (filter: Record<string, string> = {}) => adminHref('/admin/logs', { domain: 'all', workspaceId: id, returnTo: selfHref, ...filter });
  const createdAt = formatInTimeZone(w.createdAt, timeZone, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }, locale);
  const membersLabel = t('members');
  const roleLabels: Record<string, string> = {
    owner: t('workspaceRoleOwner'),
    member: t('workspaceRoleMember'),
  };
  const statusLabels: Record<string, string> = {
    running: t('deploymentStatusRunning'),
    provisioning: t('deploymentStatusProvisioning'),
    stopped: t('deploymentStatusStopped'),
    error: t('deploymentStatusError'),
  };

  return (
    <AdminPage className="max-w-5xl">
      <AdminPageHeader
        title={w.name}
        description={(
          <>
            {t('owner')}{' '}
            <Link href={adminHref(`/admin/users/${w.owner.id}`, { returnTo: selfHref })} className="font-medium text-foreground hover:underline">
              {w.owner.email}
            </Link>{' '}
            · {t('created')} {createdAt}
          </>
        )}
        meta={<><AdminBadge tone="neutral">/{w.slug}</AdminBadge><AdminBadge tone={w.status === 'active' ? 'success' : 'warning'}>{ops.has(w.status) ? ops(w.status) : w.status}</AdminBadge></>}
        backHref={backHref}
        backLabel={t('workspaces')}
        actions={<><Link href={logsHref()} className="ui-button-secondary"><Activity className="size-4" />{ops('activity')}</Link><Link href={logsHref({ tab: 'audit' })} className="ui-button-secondary"><ShieldCheck className="size-4" />{ops('audit')}</Link></>}
      />

      <AdminPanel
        title={membersLabel}
        actions={<AdminBadge tone="neutral">{w.members.length}</AdminBadge>}
        padded={false}
      >
        <ul className="divide-y divide-border">
          {w.members.map((member) => (
            <li key={member.user.id}>
              <Link
                href={adminHref(`/admin/users/${member.user.id}`, { returnTo: selfHref })}
                className="flex min-h-14 min-w-0 items-center justify-between gap-3 px-5 py-2.5 transition-colors hover:bg-muted/55"
              >
                <span className="min-w-0 truncate text-sm font-medium text-foreground">
                  {member.user.email}
                </span>
                <AdminBadge tone={member.role === 'owner' ? 'brand' : 'neutral'}>
                  {roleLabels[member.role] ?? member.role}
                </AdminBadge>
              </Link>
            </li>
          ))}
        </ul>
      </AdminPanel>

      <AdminPanel
        title={t('deployments')}
        actions={<AdminBadge tone="neutral">{w.deployments.length}</AdminBadge>}
        padded={false}
      >
        {w.deployments.length > 0 ? (
          <ul className="divide-y divide-border">
            {w.deployments.map((deployment) => (
              <li
                key={deployment.id}
                className="flex min-h-14 min-w-0 items-center justify-between gap-3 px-5 py-2.5"
              >
                <span className="min-w-0">
                  <Link href={logsHref({ deploymentId: deployment.id })} className="block truncate text-sm font-semibold text-foreground hover:underline">
                    {deployment.name ?? deployment.source ?? deployment.id}
                  </Link>
                  {deployment.name && deployment.source ? (
                    <code className="block truncate font-mono text-xs text-muted-foreground">
                      {deployment.source}
                    </code>
                  ) : null}
                </span>
                <AdminBadge tone={deploymentTone(deployment.status)} dot>
                  {statusLabels[deployment.status] ?? deployment.status}
                </AdminBadge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">{t('none')}</p>
        )}
      </AdminPanel>

      <div className="grid min-w-0 gap-8 lg:grid-cols-2">
        <AdminPanel title={t('agents')} actions={<AdminBadge>{w.agents.length}</AdminBadge>} padded={false}>
          {w.agents.length ? <ul className="divide-y divide-border">{w.agents.map((agent) => <li key={agent.id}>
            <Link href={logsHref({ agentId: agent.id })} className="block min-w-0 px-5 py-3 hover:bg-muted/55"><span className="block truncate text-sm font-medium">{agent.name}</span><span className="block truncate text-xs text-muted-foreground">{agent.runtimeKind} / {agent.model ?? '-'}</span></Link>
          </li>)}</ul> : <p className="px-5 py-6 text-sm text-muted-foreground">{t('none')}</p>}
        </AdminPanel>
        <AdminPanel title={ops('sandboxes')} actions={<AdminBadge>{w.sandboxes.length}</AdminBadge>} padded={false}>
          {w.sandboxes.length ? <ul className="divide-y divide-border">{w.sandboxes.map((sandbox) => <li key={sandbox.id}>
            <Link href={logsHref({ deploymentId: sandbox.deploymentId })} className="flex min-w-0 items-center justify-between gap-3 px-5 py-3 hover:bg-muted/55"><span className="min-w-0"><span className="block truncate text-sm font-medium">{sandbox.name}</span><span className="text-xs text-muted-foreground">{sandbox.kind}</span></span><AdminBadge tone={deploymentTone(sandbox.status)}>{statusLabels[sandbox.status] ?? sandbox.status}</AdminBadge></Link>
          </li>)}</ul> : <p className="px-5 py-6 text-sm text-muted-foreground">{t('none')}</p>}
        </AdminPanel>
      </div>

      <AdminPanel title={ops('recentErrors')} actions={<Link href={logsHref({ outcome: 'error' })} className="ui-button-ghost"><Activity className="size-4" />{ops('activity')}</Link>} padded={false}>
        {w.recentErrors.length ? <ul className="divide-y divide-border">{w.recentErrors.map((event) => <li key={event.id}>
          <Link href={adminHref(`/admin/logs/${event.id}`, { returnTo: selfHref })} className="flex min-w-0 flex-wrap items-center gap-3 px-5 py-3 hover:bg-muted/55"><LogOutcomeBadge outcome={event.outcome} /><span className="min-w-0 flex-1"><span className="block truncate text-sm">{event.message}</span><code className="text-xs text-muted-foreground">{event.eventName}</code></span><LogTimestamp date={event.createdAt} /></Link>
        </li>)}</ul> : <p className="px-5 py-6 text-sm text-muted-foreground">{ops('noErrors')}</p>}
      </AdminPanel>

      <AdminPanel
        title={t('dangerZone')}
        description={t('stopsAllMcpProcessesAndDeletesTheWorkspaceAndEverythingInIt')}
        tone="danger"
      >
        <p className="mb-2 text-sm">{ops('impact', { workspaces: 1, deployments: w.deployments.length, agents: w.agents.length, sandboxes: w.sandboxes.length })}</p>
        <p className="mb-4 text-sm text-muted-foreground">{ops('workspaceImpact', { members: w.members.length, toolkits: w._count.toolkits, skills: w._count.installedSkills, providers: w._count.modelProviders })}</p>
        <ConfirmDialog
          label={t('deleteWorkspace')}
          prompt={t('typeToConfirm', { value: w.slug })}
          action={deleteWorkspaceAdminAction}
          hidden={{ workspaceId: w.id, slug: w.slug }}
          confirmWord={w.slug}
          pendingLabel={t('deleting')}
          tone="danger"
        />
      </AdminPanel>
    </AdminPage>
  );
}
