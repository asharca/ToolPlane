import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/admin';
import { listDirectorySkills } from '@/lib/admin/market';

export const dynamic = 'force-dynamic';

export default async function AdminSkillsPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const t = await getTranslations('admin');
  await requireAdmin();
  const { q = '', page = '1' } = await searchParams;
  const { items, total, pageSize } = await listDirectorySkills({ page: Number(page) || 1, q });

  return (
    <div className="space-y-4 px-8 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{t('skillsMarket')} <span className="text-base font-normal text-zinc-500">({total})</span></h1>
        <div className="flex gap-2">
          <Link href="/admin/skills/import" className="inline-flex h-9 items-center rounded-md border border-zinc-200 px-4 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">{t('importFromGithub')}</Link>
          <Link href="/admin/skills/new" className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">{t('addSkill')}</Link>
        </div>
      </div>
      <form className="flex gap-2"><input name="q" defaultValue={q} placeholder={t('search')} className="h-9 w-72 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" /><button className="h-9 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700">{t('search')}</button></form>
      <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {items.map((s) => (
          <li key={s.id} className="flex items-center justify-between px-4 py-2.5">
            <Link href={`/admin/skills/${s.id}/edit`} className="min-w-0">
              <span className="block truncate text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100">{s.name} <span className="font-mono text-xs text-zinc-400">/{s.slug}</span></span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {t('score1')} {s.score} · {s._count.installs} {t('installs')}
                {Array.isArray(s.files) && s.files.length > 0 ? ` · bundle ${s.files.length + 1} files` : ''}
              </span>
            </Link>
            {s.curated ? <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">{t('curated')}</span> : null}
          </li>
        ))}
      </ul>
      <Pagination total={total} page={Number(page) || 1} pageSize={pageSize} q={q} />
    </div>
  );
}

async function Pagination({ total, page, pageSize, q }: { total: number; page: number; pageSize: number; q: string }) {
  const t = await getTranslations('admin');
  const pages = Math.ceil(total / pageSize);
  if (pages <= 1) return null;
  const qs = (p: number) => `?q=${encodeURIComponent(q)}&page=${p}`;
  return (
    <div className="flex items-center gap-2 text-sm">
      {page > 1 ? <Link href={qs(page - 1)} className="rounded-md border border-zinc-200 px-3 py-1 dark:border-zinc-700">{t('prev')}</Link> : null}
      <span className="text-zinc-500">{t('page')} {page} / {pages}</span>
      {page < pages ? <Link href={qs(page + 1)} className="rounded-md border border-zinc-200 px-3 py-1 dark:border-zinc-700">{t('next')}</Link> : null}
    </div>
  );
}
