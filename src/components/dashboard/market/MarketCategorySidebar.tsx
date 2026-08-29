import Link from 'next/link';

export type MarketCategoryLink = {
  href: string;
  name: string;
  count: number;
  active?: boolean;
};

export function MarketCategorySidebar({
  label,
  allLabel,
  allHref,
  allCount,
  allActive,
  categories,
}: {
  label: string;
  allLabel: string;
  allHref: string;
  allCount: number;
  allActive?: boolean;
  categories: MarketCategoryLink[];
}) {
  const isAllActive = allActive ?? !categories.some((category) => category.active);

  return (
    <aside aria-label={label} className="min-w-0 lg:sticky lg:top-14 lg:self-start">
      <p className="mb-2 hidden px-2 text-xs font-semibold text-muted-foreground lg:block">{label}</p>
      <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:max-h-[calc(100dvh-8rem)] lg:flex-col lg:overflow-y-auto lg:px-0 lg:pb-0">
        <Link
          href={allHref}
          aria-current={isAllActive ? 'page' : undefined}
          className={`flex h-9 shrink-0 items-center justify-between gap-3 rounded-md px-2.5 text-sm transition-colors ${
            isAllActive ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
          }`}
        >
          <span>{allLabel}</span>
          <span className="text-xs tabular-nums opacity-70">{allCount}</span>
        </Link>
        {categories.map((category) => (
          <Link
            key={`${category.name}-${category.href}`}
            href={category.href}
            aria-current={category.active ? 'page' : undefined}
            className={`flex h-9 shrink-0 items-center justify-between gap-3 rounded-md px-2.5 text-sm transition-colors ${
              category.active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            }`}
          >
            <span className="whitespace-nowrap lg:truncate">{category.name}</span>
            <span className="text-xs tabular-nums opacity-70">{category.count}</span>
          </Link>
        ))}
      </nav>
    </aside>
  );
}
