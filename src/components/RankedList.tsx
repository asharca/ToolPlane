import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export interface RankedItem {
  slug: string;
  name: string;
  author: string | null;
  iconUrl: string | null;
  href: string;
  stat: number;
}

export async function RankedList({
  title,
  subtitle,
  items,
}: {
  title: string;
  subtitle?: string;
  items: RankedItem[];
}) {
  const t = await getTranslations('common');
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-bold tracking-tight text-foreground">
        {title}
      </h1>
      {subtitle ? (
        <p className="mb-6 text-sm text-muted-foreground">{subtitle}</p>
      ) : (
        <div className="mb-6" />
      )}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noEntriesYet')}</p>
      ) : (
        <ol className="divide-y divide-border rounded-lg border border-border">
          {items.map((item, i) => (
            <li key={item.slug}>
              <Link
                href={item.href}
                className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/50"
              >
                <span className="w-6 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                {item.iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.iconUrl}
                    alt={item.author ?? item.name}
                    width={24}
                    height={24}
                    className="size-6 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <div className="size-6 shrink-0 rounded-full bg-muted" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {item.name}
                </span>
                <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                  {item.stat.toLocaleString()}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
