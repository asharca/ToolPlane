import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/admin';
import { getWorkspaceDetail } from '@/lib/admin/workspaces';
import { deleteWorkspaceAdminAction } from '@/lib/admin/workspace-actions';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';

export const dynamic = 'force-dynamic';

export default async function AdminWorkspaceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const t = await getTranslations('admin');
  const admin = await requireAdmin();
  const timeZone = resolveUserTimeZone(admin);
  const { id } = await params;
  const w = await getWorkspaceDetail(id);
  if (!w) notFound();

  return (
    <div className="max-w-2xl space-y-6 px-8 py-6">
      <Link href="/admin/workspaces" className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">{t('workspaces')}</Link>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{w.name} <span className="text-base font-normal text-zinc-400">/{w.slug}</span></h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {t('owner')} {w.owner.email} {t('created')} {formatInTimeZone(w.createdAt, timeZone, {
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
          })}
        </p>
      </div>

      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('members')}</h2>
        <ul className="space-y-1 text-sm">
          {w.members.map((m) => <li key={m.user.id} className="text-zinc-700 dark:text-zinc-300">{m.user.email} <span className="text-zinc-400">· {m.role}</span></li>)}
        </ul>
      </section>

      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('deployments3')}{w.deployments.length})</h2>
        <ul className="space-y-1 text-sm">
          {w.deployments.map((d) => <li key={d.id} className="text-zinc-700 dark:text-zinc-300">{d.name ?? d.source ?? d.id} <span className="text-zinc-400">· {d.status}</span></li>)}
          {w.deployments.length === 0 ? <li className="text-zinc-500">{t('none')}</li> : null}
        </ul>
      </section>

      <section className="rounded-lg border border-red-200 p-4 dark:border-red-500/30">
        <h2 className="mb-1 text-sm font-semibold text-red-700 dark:text-red-400">{t('dangerZone')}</h2>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">{t('stopsAllMcpProcessesAndDeletesTheWorkspaceAndEverythingInIt')}</p>
        <ConfirmDialog
          label={t('deleteWorkspace')}
          prompt={`Type ${w.slug} to confirm:`}
          action={deleteWorkspaceAdminAction}
          hidden={{ workspaceId: w.id, slug: w.slug }}
          confirmWord={w.slug}
          pendingLabel={t('deleting')}
        />
      </section>
    </div>
  );
}
