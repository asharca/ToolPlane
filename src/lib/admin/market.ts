import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/observability/audit";
import { normalizeAdminPage } from "@/lib/admin/pagination";
import {
  parseMcpToolCatalogResult,
  withMcpToolCatalog,
  type McpToolDefinition,
} from "@/lib/process/mcp-tool-catalog";

const PAGE_SIZE = 25;

// ---- Servers ----

export async function listDirectoryServers({
  page = 1,
  q = "",
}: {
  page?: number;
  q?: string;
}) {
  const currentPage = normalizeAdminPage(page);
  const where = q
    ? {
        OR: [
          { name: { contains: q, mode: "insensitive" as const } },
          { slug: { contains: q, mode: "insensitive" as const } },
        ],
      }
    : {};
  const skip = (currentPage - 1) * PAGE_SIZE;
  const [items, total] = await Promise.all([
    db.server.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip,
      take: PAGE_SIZE,
      select: {
        id: true,
        slug: true,
        name: true,
        stars: true,
        isOfficial: true,
        isFeatured: true,
        curated: true,
        verifiedAt: true,
        _count: { select: { deployments: true } },
      },
    }),
    db.server.count({ where }),
  ]);
  return { items, total, page: currentPage, pageSize: PAGE_SIZE };
}

export function getDirectoryServer(id: string) {
  return db.server.findUnique({
    where: { id },
    include: {
      categories: { select: { id: true } },
      _count: { select: { deployments: true } },
    },
  });
}

export async function deleteDirectoryServer(id: string, actorId = "system") {
  await db.$transaction(
    async (tx) => {
      const s = await tx.server.findUnique({
        where: { id },
        select: { _count: { select: { deployments: true } } },
      });
      if (!s) throw new Error("Server not found.");
      if (s._count.deployments > 0)
        throw new Error(
          `Refused: ${s._count.deployments} live deployment(s) reference this server.`,
        );
      await tx.server.delete({ where: { id } });
      await writeAudit(tx, {
        actorId,
        action: "catalog.server.deleted",
        targetType: "server",
        targetId: id,
      });
    },
    { isolationLevel: "Serializable" },
  );
}

// Mark a server's recipe as validated (call after a successful live probe).
export async function setServerVerified(
  id: string,
  toolCount: number,
  toolCatalog: McpToolDefinition[],
  expectedUpdatedAt?: Date,
  actorId = "system",
) {
  const catalog = parseMcpToolCatalogResult(toolCatalog);
  if (
    !Number.isInteger(toolCount) ||
    toolCount < 0 ||
    !catalog.ok ||
    catalog.tools.length !== toolCount
  ) {
    throw new Error(
      "Server validation did not return a complete tool catalog.",
    );
  }
  await db.$transaction(async (tx) => {
    const server = await tx.server.findUniqueOrThrow({
      where: { id },
      select: { installCfg: true, updatedAt: true },
    });
    const updated = await tx.server.updateMany({
      where: { id, updatedAt: expectedUpdatedAt ?? server.updatedAt },
      data: {
        installCfg: withMcpToolCatalog(
          server.installCfg,
          catalog.tools,
        ) as Prisma.InputJsonValue,
        verifiedAt: new Date(),
        verifiedTools: toolCount,
      },
    });
    if (updated.count !== 1)
      throw new Error("Server recipe changed during validation.");
    await writeAudit(tx, {
      actorId,
      action: "catalog.server.verified",
      targetType: "server",
      targetId: id,
      changes: { toolCount },
    });
  });
}

// ---- Skills ----

export async function listDirectorySkills({
  page = 1,
  q = "",
}: {
  page?: number;
  q?: string;
}) {
  const currentPage = normalizeAdminPage(page);
  const where = q
    ? {
        OR: [
          { name: { contains: q, mode: "insensitive" as const } },
          { slug: { contains: q, mode: "insensitive" as const } },
        ],
      }
    : {};
  const skip = (currentPage - 1) * PAGE_SIZE;
  const [items, total] = await Promise.all([
    db.skill.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip,
      take: PAGE_SIZE,
      select: {
        id: true,
        slug: true,
        name: true,
        score: true,
        curated: true,
        files: true,
        _count: { select: { installs: true } },
      },
    }),
    db.skill.count({ where }),
  ]);
  return { items, total, page: currentPage, pageSize: PAGE_SIZE };
}

export function getDirectorySkill(id: string) {
  return db.skill.findUnique({
    where: { id },
    include: {
      categories: { select: { id: true } },
      _count: { select: { installs: true } },
    },
  });
}

export async function deleteDirectorySkill(id: string, actorId = "system") {
  await db.$transaction(
    async (tx) => {
      const s = await tx.skill.findUnique({
        where: { id },
        select: { _count: { select: { installs: true } } },
      });
      if (!s) throw new Error("Skill not found.");
      if (s._count.installs > 0)
        throw new Error(
          `Refused: ${s._count.installs} workspace install(s) reference this skill.`,
        );
      await tx.skill.delete({ where: { id } });
      await writeAudit(tx, {
        actorId,
        action: "catalog.skill.deleted",
        targetType: "skill",
        targetId: id,
      });
    },
    { isolationLevel: "Serializable" },
  );
}
