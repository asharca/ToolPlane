import 'server-only';
import { db } from '@/lib/db';

export function listCategories() {
  return db.category.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      slug: true,
      name: true,
      marketListings: { select: { kind: true, sourceSkillId: true } },
      _count: {
        select: {
          servers: true,
          skills: true,
          clients: true,
          agentListings: true,
          toolkits: true,
        },
      },
    },
  }).then((categories) => categories.map(({ marketListings, _count, ...category }) => {
    const marketCount = (kind: string) => marketListings.filter((listing) => listing.kind === kind).length;
    return {
      ...category,
      _count: {
        clients: _count.clients,
        servers: _count.servers,
        skills: _count.skills + marketListings.filter((listing) => (
          listing.kind === 'skill' && !listing.sourceSkillId
        )).length,
        agentListings: _count.agentListings,
        assistants: marketCount('assistant'),
        toolkits: _count.toolkits,
      },
    };
  }));
}

export async function createCategory(slug: string, name: string) {
  return db.category.create({ data: { slug, name } });
}

export async function updateCategory(id: string, name: string) {
  return db.category.update({ where: { id }, data: { name } });
}

export async function deleteCategory(id: string) {
  const c = await db.category.findUnique({
    where: { id },
    select: {
      _count: {
        select: {
          servers: true,
          skills: true,
          clients: true,
          agentListings: true,
          marketListings: true,
          toolkits: true,
        },
      },
    },
  });
  if (!c) throw new Error('Category not found.');
  if (Object.values(c._count).some((count) => count > 0)) {
    throw new Error('Category is not empty.');
  }
  await db.category.delete({ where: { id } });
}
