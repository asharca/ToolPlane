import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/admin';
import { getUserDetail } from '@/lib/admin/users';
import { setUserRoleAction, setUserStatusAction, deleteUserAction } from '@/lib/admin/user-actions';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';

export const dynamic = 'force-dynamic';

export default async function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const t = await getTranslations('admin');
  const admin = await requireAdmin();
  const { id } = await params;
  const u = await getUserDetail(id);
  if (!u) notFound();
  const isSelf = admin.id === u.id;

  return (
    <div className="max-w-2xl space-y-6 px-8 py-6">
      <Link href="/admin/users" className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">{t('users1')}</Link>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{u.name ?? u.email}</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{u.email} {t('joined')} {new Date(u.createdAt).toLocaleDateString('en-US')}</p>
      </div>

      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('access')}</h2>
        {isSelf ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('youCanapostChangeYourOwnRoleOrStatus')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
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
            />
          </div>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('ownedWorkspaces')}</h2>
        <ul className="space-y-1 text-sm">
          {u.ownedWorkspaces.map((w) => (
            <li key={w.id}><Link href={`/admin/workspaces/${w.id}`} className="text-zinc-700 hover:underline dark:text-zinc-300">{w.name}</Link> <span className="text-zinc-400">/{w.slug}</span></li>
          ))}
          {u.ownedWorkspaces.length === 0 ? <li className="text-zinc-500">{t('none')}</li> : null}
        </ul>
      </section>

      {!isSelf ? (
        <section className="rounded-lg border border-red-200 p-4 dark:border-red-500/30">
          <h2 className="mb-1 text-sm font-semibold text-red-700 dark:text-red-400">{t('dangerZone')}</h2>
          <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">{t('deletingCascadesToAllOwnedWorkspacesDeploymentsAndAgents')}</p>
          <ConfirmDialog
            label={t('deleteUser')}
            prompt={`Type ${u.email} to confirm:`}
            action={deleteUserAction}
            hidden={{ userId: u.id, email: u.email }}
            confirmWord={u.email}
            pendingLabel={t('deleting')}
          />
        </section>
      ) : null}
    </div>
  );
}
