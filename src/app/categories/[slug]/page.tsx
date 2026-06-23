import { notFound } from 'next/navigation';
import { getCategory } from '@/lib/queries/categories';
import { ServerCard } from '@/components/cards/ServerCard';

export const dynamic = 'force-dynamic';

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const category = await getCategory(slug);
  if (!category) notFound();

  return (
    <div className="mx-auto max-w-screen-xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-bold tracking-tight text-foreground">
        {category.name}
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {category.servers.length.toLocaleString()} servers
      </p>
      {category.servers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No servers in this category yet.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {category.servers.map((server) => (
            <ServerCard key={server.slug} server={server} />
          ))}
        </div>
      )}
    </div>
  );
}
