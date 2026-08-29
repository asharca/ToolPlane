import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { normalizeAdminPage } from '@/lib/admin/pagination';
import { parseServerRecipe, type ServerRecipe } from '@/lib/workspace/server-recipe';
import {
  parseMcpToolCatalogResult,
  withMcpToolCatalog,
  type McpToolDefinition,
} from '@/lib/process/mcp-tool-catalog';

const PAGE_SIZE = 25;

export type ServerInput = {
  slug: string; name: string; author: string | null; description: string | null;
  iconUrl: string | null; stars: number; isOfficial: boolean; isFeatured: boolean; categoryIds: string[];
  readme?: string | null;
  sourceMetadata?: Pick<ServerRecipe, 'source' | 'ref' | 'sourceUrl'>;
};

export type SkillInput = {
  slug: string; name: string; author: string | null; description: string | null;
  iconUrl: string | null; githubSource: string | null; content?: string | null;
  files?: Prisma.InputJsonValue; score: number; categoryIds: string[];
};

// ---- Servers ----

export async function listDirectoryServers({ page = 1, q = '' }: { page?: number; q?: string }) {
  const currentPage = normalizeAdminPage(page);
  const where = q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { slug: { contains: q, mode: 'insensitive' as const } }] } : {};
  const skip = (currentPage - 1) * PAGE_SIZE;
  const [items, total] = await Promise.all([
    db.server.findMany({
      where, orderBy: { updatedAt: 'desc' }, skip, take: PAGE_SIZE,
      select: { id: true, slug: true, name: true, stars: true, isOfficial: true, isFeatured: true, curated: true, verifiedAt: true, _count: { select: { deployments: true } } },
    }),
    db.server.count({ where }),
  ]);
  return { items, total, page: currentPage, pageSize: PAGE_SIZE };
}

export function getDirectoryServer(id: string) {
  return db.server.findUnique({ where: { id }, include: { categories: { select: { id: true } }, _count: { select: { deployments: true } } } });
}

export function createDirectoryServer(input: ServerInput) {
  const { categoryIds, sourceMetadata, ...rest } = input;
  return db.server.create({
    data: {
      ...rest,
      curated: true,
      ...(sourceMetadata ? { installCfg: { ...sourceMetadata, env: [] } as Prisma.InputJsonValue } : {}),
      categories: { connect: categoryIds.map((id) => ({ id })) },
    },
  });
}

export async function updateDirectoryServer(id: string, input: Omit<ServerInput, 'slug'>) {
  const { categoryIds, sourceMetadata, ...rest } = input;
  const server = sourceMetadata
    ? await db.server.findUniqueOrThrow({ where: { id }, select: { installCfg: true } })
    : null;
  const recipe = parseServerRecipe(server?.installCfg);
  const sameRecipe = Boolean(
    sourceMetadata && recipe
    && sourceMetadata.source === recipe.source
    && sourceMetadata.ref === recipe.ref,
  );
  const storedConfig = server?.installCfg && typeof server.installCfg === 'object' && !Array.isArray(server.installCfg)
    ? server.installCfg as Record<string, unknown>
    : {};
  return db.server.update({
    where: { id },
    data: {
      ...rest,
      curated: true,
      ...(sourceMetadata ? {
        installCfg: (sameRecipe
          ? { ...storedConfig, sourceUrl: sourceMetadata.sourceUrl }
          : { ...sourceMetadata, env: [] }) as Prisma.InputJsonValue,
        ...(!sameRecipe ? { verifiedAt: null, verifiedTools: null } : {}),
      } : {}),
      categories: { set: categoryIds.map((cid) => ({ id: cid })) },
    },
  });
}

export async function deleteDirectoryServer(id: string) {
  const s = await db.server.findUnique({ where: { id }, select: { _count: { select: { deployments: true } } } });
  if (!s) throw new Error('Server not found.');
  if (s._count.deployments > 0) throw new Error(`Refused: ${s._count.deployments} live deployment(s) reference this server.`);
  await db.server.delete({ where: { id } });
}

// Store/replace a server's deploy recipe (in installCfg). Changing the recipe
// clears verification — it must be re-validated before becoming deployable.
// Passing null removes the recipe entirely.
export function setServerRecipe(id: string, recipe: ServerRecipe | null) {
  return db.server.update({
    where: { id },
    data: {
      installCfg: recipe ? (recipe as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      verifiedAt: null,
      verifiedTools: null,
    },
  });
}

// Mark a server's recipe as validated (call after a successful live probe).
export async function setServerVerified(
  id: string,
  toolCount: number,
  toolCatalog: McpToolDefinition[],
  expectedUpdatedAt?: Date,
) {
  const catalog = parseMcpToolCatalogResult(toolCatalog);
  if (!Number.isInteger(toolCount) || toolCount < 0 || !catalog.ok || catalog.tools.length !== toolCount) {
    throw new Error('Server validation did not return a complete tool catalog.');
  }
  const server = await db.server.findUniqueOrThrow({ where: { id }, select: { installCfg: true, updatedAt: true } });
  const updated = await db.server.updateMany({
    where: { id, updatedAt: expectedUpdatedAt ?? server.updatedAt },
    data: {
      installCfg: withMcpToolCatalog(server.installCfg, catalog.tools) as Prisma.InputJsonValue,
      verifiedAt: new Date(),
      verifiedTools: toolCount,
    },
  });
  if (updated.count !== 1) throw new Error('Server recipe changed during validation.');
}

// ---- Skills ----

export async function listDirectorySkills({ page = 1, q = '' }: { page?: number; q?: string }) {
  const currentPage = normalizeAdminPage(page);
  const where = q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { slug: { contains: q, mode: 'insensitive' as const } }] } : {};
  const skip = (currentPage - 1) * PAGE_SIZE;
  const [items, total] = await Promise.all([
    db.skill.findMany({
      where, orderBy: { updatedAt: 'desc' }, skip, take: PAGE_SIZE,
      select: { id: true, slug: true, name: true, score: true, curated: true, files: true, _count: { select: { installs: true } } },
    }),
    db.skill.count({ where }),
  ]);
  return { items, total, page: currentPage, pageSize: PAGE_SIZE };
}

export function getDirectorySkill(id: string) {
  return db.skill.findUnique({ where: { id }, include: { categories: { select: { id: true } }, _count: { select: { installs: true } } } });
}

export function createDirectorySkill(input: SkillInput) {
  const { categoryIds, ...rest } = input;
  return db.skill.create({ data: { ...rest, curated: true, categories: { connect: categoryIds.map((id) => ({ id })) } } });
}

export function updateDirectorySkill(id: string, input: Omit<SkillInput, 'slug'>) {
  const { categoryIds } = input;
  return db.skill.update({
    where: { id },
    data: {
      name: input.name,
      author: input.author,
      description: input.description,
      iconUrl: input.iconUrl,
      githubSource: input.githubSource,
      score: input.score,
      curated: true,
      categories: { set: categoryIds.map((cid) => ({ id: cid })) },
    },
  });
}

export async function deleteDirectorySkill(id: string) {
  const s = await db.skill.findUnique({ where: { id }, select: { _count: { select: { installs: true } } } });
  if (!s) throw new Error('Skill not found.');
  if (s._count.installs > 0) throw new Error(`Refused: ${s._count.installs} workspace install(s) reference this skill.`);
  await db.skill.delete({ where: { id } });
}
