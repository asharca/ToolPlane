import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Search } from 'lucide-react';

type Category = { slug: string; name: string };

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

// Shared header for directory listing pages (servers, skills, clients).
export async function ListingHero({
  lead,
  tail,
  subtitle,
  placeholder,
  categories,
  searchAction = '/search',
}: {
  lead: string;
  tail: string;
  subtitle: string;
  placeholder: string;
  categories: Category[];
  searchAction?: string;
}) {
  const t = await getTranslations('common');
  return (
    <section className="relative py-14 sm:py-20">
      <div className="relative text-center">
        <h1 className="mx-auto max-w-4xl text-balance text-5xl font-black tracking-tight sm:text-7xl">
          <span className="text-foreground">{lead}</span>{' '}
          <span className="text-muted-foreground">{tail}</span>
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-base text-muted-foreground">
          {subtitle}
        </p>
        <form action={searchAction} className="relative mx-auto mt-8 max-w-2xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            name="q"
            placeholder={placeholder}
            aria-label={placeholder}
            className="ui-input ui-input-search bg-card"
          />
        </form>
        {categories.length > 0 ? (
          <nav
            aria-label={t('browseCategories')}
            className="mx-auto mt-5 flex max-w-3xl snap-x gap-2 overflow-x-auto pb-2 sm:flex-wrap sm:justify-center sm:overflow-visible"
          >
            <CategoryChip href="/categories" label={t('all')} />
            {categories.slice(0, 8).map((c) => (
              <CategoryChip
                key={c.slug}
                href={`/categories/${c.slug}`}
                label={c.name}
              />
            ))}
          </nav>
        ) : null}
      </div>
    </section>
  );
}
