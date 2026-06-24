import Link from 'next/link';
import { listCategories } from '@/lib/queries/categories';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const categories = await listCategories();
  return (
    <div className="mx-auto max-w-screen-xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-bold tracking-tight text-foreground">
        Categories
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {categories.length.toLocaleString()} categories
      </p>
      {categories.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No categories yet. Run detail enrichment to populate them.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map((c) => (
            <Link
              key={c.slug}
              href={`/categories/${c.slug}`}
              className="flex items-center justify-between rounded-lg border border-border px-4 py-3 text-sm transition-colors hover:bg-accent/50"
            >
              <span className="font-medium text-foreground">{c.name}</span>
              <span className="text-xs text-muted-foreground">
                {c._count.servers}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
