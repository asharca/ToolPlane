import 'server-only';
import { db } from '@/lib/db';
import { writeAudit } from '@/lib/observability/audit';

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

export async function createCategory(slug: string, name: string, actorId = 'system') {
  return db.$transaction(async (tx) => {
    const category = await tx.category.create({ data: { slug, name } });
    await writeAudit(tx, { actorId, action: 'category.created', targetType: 'category', targetId: category.id, changes: { slug, name } });
    return category;
  });
}

export async function updateCategory(id: string, name: string, actorId = 'system') {
  return db.$transaction(async (tx) => {
    const before = await tx.category.findUniqueOrThrow({ where: { id }, select: { name: true } });
    const category = await tx.category.update({ where: { id }, data: { name } });
    await writeAudit(tx, { actorId, action: 'category.updated', targetType: 'category', targetId: id, changes: { before, after: { name } } });
    return category;
  });
}

export async function deleteCategory(id: string, actorId = 'system') {
  return db.$transaction(async (tx) => {
    const c = await tx.category.findUnique({
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
    await tx.category.delete({ where: { id } });
    await writeAudit(tx, { actorId, action: 'category.deleted', targetType: 'category', targetId: id });
  }, { isolationLevel: 'Serializable' });
}
