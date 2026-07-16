import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
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

export default async function AdminWorkspaceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [t, locale] = await Promise.all([getTranslations('admin'), getLocale()]);
  const admin = await requireAdmin();
  const timeZone = resolveUserTimeZone(admin);
  const { id } = await params;
  const w = await getWorkspaceDetail(id);
  if (!w) notFound();
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
            <Link href={`/admin/users/${w.owner.id}`} className="font-medium text-foreground hover:underline">
              {w.owner.email}
            </Link>{' '}
            · {t('created')} {createdAt}
          </>
        )}
        meta={<AdminBadge tone="neutral">/{w.slug}</AdminBadge>}
        backHref="/admin/workspaces"
        backLabel={t('workspaces')}
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
                href={`/admin/users/${member.user.id}`}
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
                  <span className="block truncate text-sm font-semibold text-foreground">
                    {deployment.name ?? deployment.source ?? deployment.id}
                  </span>
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

      <AdminPanel
        title={t('dangerZone')}
        description={t('stopsAllMcpProcessesAndDeletesTheWorkspaceAndEverythingInIt')}
        tone="danger"
      >
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
