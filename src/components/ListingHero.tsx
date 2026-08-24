import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Search } from 'lucide-react';

type Category = { slug: string; name: string };

type HiddenFieldValue = string | number | boolean;

function CategoryChip({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`ui-chip snap-start ${active ? 'ui-chip-active' : ''}`}
    >
      {label}
    </Link>
  );
}

// Shared header for directory listing pages (servers, skills, clients, agents).
export async function ListingHero({
  lead,
  tail,
  subtitle,
  placeholder,
  categories,
  searchAction = '/search',
  defaultSearchValue,
  activeCategory,
  categoryHref = (slug) =>
    slug ? `/categories/${encodeURIComponent(slug)}` : '/categories',
  hiddenFields,
}: {
  lead: string;
  tail: string;
  subtitle: string;
  placeholder: string;
  categories: Category[];
  searchAction?: string;
  defaultSearchValue?: string;
  activeCategory?: string | null;
  categoryHref?: (slug: string | null) => string;
  hiddenFields?: Record<string, HiddenFieldValue | null | undefined>;
}) {
  const t = await getTranslations('common');
  return (
    <section className="relative mt-1 overflow-hidden rounded-[14px] border border-border/80 bg-card px-5 py-10 sm:mt-2 sm:px-8 sm:py-12">
      <div aria-hidden="true" className="pointer-events-none absolute -right-20 -top-28 size-64 rounded-full bg-brand/10 blur-3xl" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand/35 to-transparent" />
      <div className="relative text-center">
        <h1 className="mx-auto max-w-4xl text-balance text-4xl font-semibold tracking-[-0.04em] sm:text-6xl">
          <span className="text-foreground">{lead}</span>{' '}
          <span className="text-muted-foreground">{tail}</span>
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
          {subtitle}
        </p>
        <form action={searchAction} className="relative mx-auto mt-7 max-w-2xl">
          <Search aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            name="q"
            defaultValue={defaultSearchValue}
            placeholder={placeholder}
            aria-label={placeholder}
            className="ui-input ui-input-search !h-12 !pl-11 bg-background shadow-sm"
          />
          {Object.entries(hiddenFields ?? {}).map(([name, value]) =>
            value === null || value === undefined ? null : (
              <input key={name} type="hidden" name={name} value={String(value)} />
            ),
          )}
        </form>
        {categories.length > 0 ? (
          <nav
            aria-label={t('browseCategories')}
            className="mx-auto mt-4 flex max-w-3xl snap-x gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:justify-center sm:overflow-visible"
          >
            <CategoryChip
              href={categoryHref(null)}
              label={t('all')}
              active={!activeCategory}
            />
            {categories.slice(0, 8).map((c) => (
              <CategoryChip
                key={c.slug}
                href={categoryHref(c.slug)}
                label={c.name}
                active={activeCategory === c.slug}
              />
            ))}
          </nav>
        ) : null}
      </div>
    </section>
  );
}
