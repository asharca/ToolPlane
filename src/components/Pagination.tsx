import { getTranslations } from 'next-intl/server';
import { Button, ButtonLink } from '@/components/motion/button';

function pageWindow(page: number, total: number): number[] {
  const span = 2;
  const start = Math.max(1, page - span);
  const end = Math.min(total, page + span);
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}


type PaginationProps = {
  page: number;
  totalPages: number;
} & (
  | {
      basePath: string;
      pagePath: string;
      hrefForPage?: never;
    }
  | {
      basePath?: never;
      pagePath?: never;
      hrefForPage: (page: number) => string;
    }
);

export async function Pagination(props: PaginationProps) {
  const { page, totalPages } = props;
  const t = await getTranslations('common');
  if (totalPages <= 1) return null;
  const href = props.hrefForPage ?? ((p: number) =>
    p <= 1 ? props.basePath : `${props.pagePath}/${p}`
  );
  const nums = pageWindow(page, totalPages);

  return (
    <nav
      aria-label={t('pagination')}
      className="mt-10 flex flex-wrap items-center justify-center gap-1"
    >
      {page > 1 ? (
        <ButtonLink href={href(page - 1)} variant="secondary" size="sm">
          {t('previous')}
        </ButtonLink>
      ) : (
        <Button disabled variant="secondary" size="sm">
          {t('previous')}
        </Button>
      )}

      {nums[0] > 1 ? (
        <>
          <ButtonLink href={href(1)} variant="secondary" size="sm">
            1
          </ButtonLink>
          <span className="px-1 text-muted-foreground">…</span>
        </>
      ) : null}

      {nums.map((n) =>
        n === page ? (
          <ButtonLink key={n} href={href(n)} aria-current="page" size="sm">
            {n}
          </ButtonLink>
        ) : (
          <ButtonLink key={n} href={href(n)} variant="secondary" size="sm">
            {n}
          </ButtonLink>
        ),
      )}

      {nums[nums.length - 1] < totalPages ? (
        <>
          <span className="px-1 text-muted-foreground">…</span>
          <ButtonLink href={href(totalPages)} variant="secondary" size="sm">
            {totalPages}
          </ButtonLink>
        </>
      ) : null}

      {page < totalPages ? (
        <ButtonLink href={href(page + 1)} variant="secondary" size="sm">
          {t('next')}
        </ButtonLink>
      ) : (
        <Button disabled variant="secondary" size="sm">{t('next')}</Button>
      )}
    </nav>
  );
}
