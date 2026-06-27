import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/admin';
import { listWorkspaces } from '@/lib/admin/workspaces';

export const dynamic = 'force-dynamic';

export default async function AdminWorkspacesPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  await requireAdmin();
  const { q = '', page = '1' } = await searchParams;
  const { items, total } = await listWorkspaces({ page: Number(page) || 1, q });

  return (
    <div className="space-y-4 px-8 py-6">
      <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">Workspaces <span className="text-base font-normal text-zinc-500">({total})</span></h1>
      <form className="flex gap-2">
        <input name="q" defaultValue={q} placeholder="Search name or slug…" className="h-9 w-72 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        <button className="h-9 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700">Search</button>
      </form>
      <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {items.map((w) => (
          <li key={w.id} className="flex items-center justify-between px-4 py-2.5">
            <Link href={`/admin/workspaces/${w.id}`} className="min-w-0">
              <span className="block truncate text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100">{w.name} <span className="text-zinc-400">/{w.slug}</span></span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{w.owner.email} · {w._count.members} members · {w._count.deployments} deployments</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
