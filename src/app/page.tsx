import { getHomeSections } from '@/lib/queries/home';
import { listCategories } from '@/lib/queries/categories';
import { db } from '@/lib/db';
import { HomeView } from '@/components/home/HomeView';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const [sections, cats, serverCount] = await Promise.all([
    getHomeSections(),
    listCategories(),
    db.server.count(),
  ]);

  const categories = [...cats]
    .sort((a, b) => b._count.servers - a._count.servers)
    .map((c) => ({ slug: c.slug, name: c.name }));

  return (
    <HomeView {...sections} categories={categories} serverCount={serverCount} />
  );
}
