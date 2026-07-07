import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

function pageWindow(page: number, total: number): number[] {
  const span = 2;
  const start = Math.max(1, page - span);
  const end = Math.min(total, page + span);
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

const itemCls =
  'inline-flex h-9 min-w-9 items-center justify-center rounded-md border border-border px-3 text-sm transition-colors hover:bg-accent';

export async function Pagination({
  page,
  totalPages,
  basePath,
  pagePath,
}: {
  page: number;
  totalPages: number;
  basePath: string;
  pagePath: string;
}) {
  const t = await getTranslations('common');
  if (totalPages <= 1) return null;
  const href = (p: number) => (p <= 1 ? basePath : `${pagePath}/${p}`);
  const nums = pageWindow(page, totalPages);

  return (
    <nav
      aria-label={t('pagination')}
      className="mt-10 flex flex-wrap items-center justify-center gap-1"
    >
      {page > 1 ? (
        <Link href={href(page - 1)} className={itemCls}>
          {t('previous')}
        </Link>
      ) : (
        <span className={`${itemCls} pointer-events-none opacity-40`}>
          {t('previous')}
        </span>
      )}

      {nums[0] > 1 ? (
        <>
          <Link href={href(1)} className={itemCls}>
            1
          </Link>
          <span className="px-1 text-muted-foreground">…</span>
        </>
      ) : null}

      {nums.map((n) =>
        n === page ? (
          <span
            key={n}
            aria-current="page"
            className={`${itemCls} border-foreground bg-primary text-primary-foreground`}
          >
            {n}
          </span>
        ) : (
          <Link key={n} href={href(n)} className={itemCls}>
            {n}
          </Link>
        ),
      )}

      {nums[nums.length - 1] < totalPages ? (
        <>
          <span className="px-1 text-muted-foreground">…</span>
          <Link href={href(totalPages)} className={itemCls}>
            {totalPages}
          </Link>
        </>
      ) : null}

      {page < totalPages ? (
        <Link href={href(page + 1)} className={itemCls}>
          {t('next')}
        </Link>
      ) : (
        <span className={`${itemCls} pointer-events-none opacity-40`}>{t('next')}</span>
      )}
    </nav>
  );
}
