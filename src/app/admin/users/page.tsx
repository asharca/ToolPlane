import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/admin';
import { listUsers } from '@/lib/admin/users';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  await requireAdmin();
  const { q = '', page = '1' } = await searchParams;
  const { items, total, pageSize } = await listUsers({ page: Number(page) || 1, q });

  return (
    <div className="space-y-4 px-8 py-6">
      <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">Users <span className="text-base font-normal text-zinc-500">({total})</span></h1>
      <form className="flex gap-2">
        <input name="q" defaultValue={q} placeholder="Search email or name…" className="h-9 w-72 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        <button className="h-9 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700">Search</button>
      </form>
      <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {items.map((u) => (
          <li key={u.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <Link href={`/admin/users/${u.id}`} className="min-w-0">
              <span className="block truncate text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100">{u.name ?? u.email}</span>
              <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">{u.email} · {u._count.ownedWorkspaces} ws · {u._count.apiTokens} tokens</span>
            </Link>
            <div className="flex shrink-0 items-center gap-1.5">
              {u.role === 'admin' ? <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red-700 dark:bg-red-500/15 dark:text-red-300">admin</span> : null}
              {u.status === 'suspended' ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">suspended</span> : null}
            </div>
          </li>
        ))}
      </ul>
      <Pagination total={total} page={Number(page) || 1} pageSize={pageSize} q={q} />
    </div>
  );
}

function Pagination({ total, page, pageSize, q }: { total: number; page: number; pageSize: number; q: string }) {
  const pages = Math.ceil(total / pageSize);
  if (pages <= 1) return null;
  const qs = (p: number) => `?q=${encodeURIComponent(q)}&page=${p}`;
  return (
    <div className="flex items-center gap-2 text-sm">
      {page > 1 ? <Link href={qs(page - 1)} className="rounded-md border border-zinc-200 px-3 py-1 dark:border-zinc-700">Prev</Link> : null}
      <span className="text-zinc-500">Page {page} / {pages}</span>
      {page < pages ? <Link href={qs(page + 1)} className="rounded-md border border-zinc-200 px-3 py-1 dark:border-zinc-700">Next</Link> : null}
    </div>
  );
}
