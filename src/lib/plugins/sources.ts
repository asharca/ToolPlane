import "server-only";
import { createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { encryptSecretText } from "@/lib/security/secrets";
import {
  branchSchema,
  GithubRegistryError,
  GithubRegistryTransport,
  repositorySchema,
} from "./github";
export { GithubRegistryError } from "./github";

const tokenSchema = z
  .string()
  .trim()
  .max(4096)
  .regex(/^[A-Za-z0-9_]*$/);
const registrationSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    repository: repositorySchema.transform((value) => value.toLowerCase()),
    branch: branchSchema.default("main"),
    visibility: z.enum(["public", "private"]).default("public"),
    token: tokenSchema.optional(),
  })
  .strict();
export type PluginSourceInput = z.input<typeof registrationSchema>;

async function authorize(workspaceId: string, userId: string, manage = false) {
  const workspace = await db.workspace.findFirst({
    where: {
      id: workspaceId,
      status: "active",
      OR: [
        { ownerId: userId },
        {
          members: {
            some: {
              userId,
              ...(manage ? { role: { in: ["owner", "admin"] } } : {}),
            },
          },
        },
      ],
    },
    select: { id: true },
  });
  if (!workspace) throw new GithubRegistryError("not_authorized");
}

/** Master keys never leave the server. Each source has a distinct webhook secret. */
export function deriveGithubResourceRegistryWebhookSecret(registry: {
  id: string;
  workspaceId: string | null;
}) {
  const master = process.env.TOOLPLANE_RESOURCE_REGISTRY_WEBHOOK_SECRET;
  if (!master) throw new GithubRegistryError("webhook_not_configured");
  return createHmac("sha256", master)
    .update("toolplane:resource-registry:webhook:v1\0")
    .update(JSON.stringify([registry.workspaceId, registry.id]))
    .digest("hex");
}

export async function listPluginSources(workspaceId: string, userId: string) {
  await authorize(workspaceId, userId);
  const [rows, manager, platformAdmin] = await Promise.all([
    db.githubResourceRegistry.findMany({
      where: {
        OR: [{ workspaceId }, { official: true, workspaceId: null }],
        status: { not: "disabled" },
      },
      orderBy: [{ official: "desc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        repository: true,
        branch: true,
        visibility: true,
        official: true,
        workspaceId: true,
        status: true,
        lastAppliedCommit: true,
        lastSyncAt: true,
        error: true,
        credentials: true,
      },
    }),
    db.workspace.findFirst({
      where: {
        id: workspaceId,
        OR: [
          { ownerId: userId },
          { members: { some: { userId, role: { in: ["owner", "admin"] } } } },
        ],
      },
      select: { id: true },
    }),
    db.user.findFirst({
      where: { id: userId, role: "admin", status: "active" },
      select: { id: true },
    }),
  ]);
  return rows.map(({ credentials, ...row }) => ({
    ...row,
    hasCredentials: row.official
      ? Boolean(process.env.TOOLPLANE_OFFICIAL_PLUGIN_TOKEN)
      : credentials !== null,
    canSync: row.official ? Boolean(platformAdmin) : Boolean(manager),
    webhook:
      process.env.TOOLPLANE_RESOURCE_REGISTRY_WEBHOOK_SECRET &&
      (row.official ? platformAdmin : manager)
        ? {
            path: `/api/v1/resource-registries/${row.id}/webhook`,
            secret: deriveGithubResourceRegistryWebhookSecret(row),
          }
        : null,
  }));
}

export async function createPluginSource(
  workspaceId: string,
  userId: string,
  input: PluginSourceInput,
) {
  await authorize(workspaceId, userId, true);
  const parsed = registrationSchema.safeParse(input);
  if (
    !parsed.success ||
    (parsed.data.visibility === "private" && !parsed.data.token)
  )
    throw new GithubRegistryError("registry_configuration_invalid");
  const { token, ...configuration } = parsed.data;
  await new GithubRegistryTransport(
    configuration.repository,
    token || undefined,
    configuration.visibility,
  ).assertAccess(configuration.repository);
  try {
    return await db.$transaction(async (tx) => {
      const previous = await tx.githubResourceRegistry.findUnique({
        where: {
          workspaceId_repository_branch: {
            workspaceId,
            repository: configuration.repository,
            branch: configuration.branch,
          },
        },
      });
      if (previous && previous.status !== "disabled")
        throw new GithubRegistryError("registry_already_registered");
      const data = {
        ...configuration,
        createdById: userId,
        credentials: token ? encryptSecretText(token) : Prisma.DbNull,
        status: "pending",
        error: null,
      };
      const registry = previous
        ? await tx.githubResourceRegistry.update({
            where: { id: previous.id },
            data: { ...data, generation: { increment: 1 } },
          })
        : await tx.githubResourceRegistry.create({
            data: { ...data, workspaceId, generation: 1 },
          });
      await tx.githubResourceSyncJob.create({
        data: { registryId: registry.id, generation: registry.generation },
      });
      return { id: registry.id };
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      throw new GithubRegistryError("registry_already_registered");
    throw error;
  }
}

export async function enqueuePluginSourceSync(
  registryId: string,
  deliveryId?: string,
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "GithubResourceRegistry" WHERE "id" = ${registryId} FOR UPDATE`;
    const registry = await tx.githubResourceRegistry.findUnique({
      where: { id: registryId },
    });
    if (!registry || registry.status === "disabled")
      throw new GithubRegistryError("registry_not_found");
    if (deliveryId) {
      const previous = await tx.githubResourceSyncJob.findUnique({
        where: { registryId_deliveryId: { registryId, deliveryId } },
        select: { id: true },
      });
      if (previous) return previous;
    }
    const updated = await tx.githubResourceRegistry.update({
      where: { id: registryId },
      data: { generation: { increment: 1 }, status: "pending", error: null },
    });
    return tx.githubResourceSyncJob.create({
      data: { registryId, generation: updated.generation, deliveryId },
      select: { id: true },
    });
  });
}

export async function syncPluginSource(
  workspaceId: string,
  userId: string,
  sourceId: string,
) {
  await authorize(workspaceId, userId);
  const registry = await db.githubResourceRegistry.findFirst({
    where: {
      id: sourceId,
      OR: [{ workspaceId }, { official: true, workspaceId: null }],
      status: { not: "disabled" },
    },
  });
  if (!registry) throw new GithubRegistryError("registry_not_found");
  if (registry.official) {
    if (
      !(await db.user.findFirst({
        where: { id: userId, role: "admin", status: "active" },
        select: { id: true },
      }))
    )
      throw new GithubRegistryError("not_authorized");
  } else await authorize(workspaceId, userId, true);
  return enqueuePluginSourceSync(registry.id);
}

export async function updatePluginSource(
  workspaceId: string,
  userId: string,
  sourceId: string,
  input: { name?: string; token?: string },
) {
  await authorize(workspaceId, userId, true);
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      token: tokenSchema.optional(),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success)
    throw new GithubRegistryError("registry_configuration_invalid");
  const registry = await db.githubResourceRegistry.findFirst({
    where: {
      id: sourceId,
      workspaceId,
      official: false,
      status: { not: "disabled" },
    },
  });
  if (!registry) throw new GithubRegistryError("registry_not_found");
  const token = parsed.data.token;
  if (token !== undefined) {
    if (registry.visibility === "private" && !token)
      throw new GithubRegistryError("registry_configuration_invalid");
    await new GithubRegistryTransport(
      registry.repository,
      token || undefined,
      registry.visibility,
    ).assertAccess(registry.repository);
  }
  return db.$transaction(async (tx) => {
    const changed = await tx.githubResourceRegistry.updateMany({
      where: {
        id: sourceId,
        workspaceId,
        official: false,
        status: { not: "disabled" },
      },
      data: {
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(token !== undefined
          ? { credentials: token ? encryptSecretText(token) : Prisma.DbNull }
          : {}),
        generation: { increment: 1 },
        status: "pending",
        error: null,
      },
    });
    if (!changed.count) throw new GithubRegistryError("registry_not_found");
    const updated = await tx.githubResourceRegistry.findUniqueOrThrow({
      where: { id: sourceId },
    });
    return tx.githubResourceSyncJob.create({
      data: { registryId: sourceId, generation: updated.generation },
      select: { id: true },
    });
  });
}

export async function deletePluginSource(
  workspaceId: string,
  userId: string,
  sourceId: string,
) {
  await authorize(workspaceId, userId, true);
  await disableSources({ id: sourceId, workspaceId, official: false }, true);
}
async function disableSources(
  where: Prisma.GithubResourceRegistryWhereInput,
  required = false,
) {
  return db.$transaction(async (tx) => {
    const sources = await tx.githubResourceRegistry.findMany({
      where,
      select: { id: true },
    });
    if (required && !sources.length)
      throw new GithubRegistryError("registry_not_found");
    const ids = sources.map((row) => row.id);
    await tx.githubResourceRegistry.updateMany({
      where: { id: { in: ids } },
      data: {
        status: "disabled",
        generation: { increment: 1 },
        credentials: Prisma.DbNull,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    const resources = await tx.githubRegistryResource.findMany({
      where: { registryId: { in: ids } },
      select: { listingId: true },
    });
    await tx.marketListing.updateMany({
      where: {
        id: {
          in: resources.flatMap((row) =>
            row.listingId ? [row.listingId] : [],
          ),
        },
        status: { not: "withdrawn" },
      },
      data: { status: "removed" },
    });
    await tx.githubRegistryResource.updateMany({
      where: { registryId: { in: ids } },
      data: { active: false },
    });
    await tx.githubResourceSyncJob.updateMany({
      where: {
        registryId: { in: ids },
        status: { in: ["pending", "running"] },
      },
      data: { status: "cancelled", finishedAt: new Date(), leaseToken: null },
    });
  });
}

export async function queueGithubResourceWebhook(input: {
  registryId: string;
  repository: string;
  ref: string;
  deliveryId: string;
}) {
  const registry = await db.githubResourceRegistry.findUnique({
    where: { id: input.registryId },
    select: { repository: true, branch: true, status: true },
  });
  if (!registry || registry.status === "disabled")
    throw new GithubRegistryError("registry_not_found");
  if (
    registry.repository.toLowerCase() !== input.repository.toLowerCase() ||
    input.ref !== `refs/heads/${registry.branch}`
  )
    return { ignored: true };
  return enqueuePluginSourceSync(input.registryId, input.deliveryId);
}

/** Provisioning is deployer-owned. The official token is never persisted. */
export async function provisionOfficialPluginSource() {
  const repository = (
    process.env.TOOLPLANE_OFFICIAL_PLUGIN_REPOSITORY ??
    "asharca/toolplane-plugins"
  )
    .trim()
    .toLowerCase();
  if (!repository) {
    await disableSources({
      official: true,
      workspaceId: null,
      status: { not: "disabled" },
    });
    return;
  }
  const branch = process.env.TOOLPLANE_OFFICIAL_PLUGIN_BRANCH ?? "main";
  if (
    !repositorySchema.safeParse(repository).success ||
    !branchSchema.safeParse(branch).success
  )
    throw new GithubRegistryError("registry_configuration_invalid");
  await db.$transaction(async (tx) => {
    // Serialize concurrent Node startup hooks; nullable composite unique cannot be used by Prisma upsert.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('toolplane:official-plugin-source'))`;
    const previous = await tx.githubResourceRegistry.findFirst({
      where: { official: true, workspaceId: null },
      orderBy: { createdAt: "asc" },
    });
    const changed =
      previous?.repository !== repository || previous?.branch !== branch;
    const needsSync =
      changed || !previous?.lastSyncAt || previous.status === "disabled";
    const source = previous
      ? await tx.githubResourceRegistry.update({
          where: { id: previous.id },
          data: {
            repository,
            branch,
            official: true,
            credentials: Prisma.DbNull,
            ...(needsSync
              ? {
                  status: "pending",
                  error: null,
                  generation: { increment: 1 },
                  leaseToken: null,
                  leaseExpiresAt: null,
                }
              : {}),
          },
        })
      : await tx.githubResourceRegistry.create({
          data: {
            official: true,
            workspaceId: null,
            name: "Official plugins",
            repository,
            branch,
            visibility: "public",
            generation: 1,
          },
        });
    if (needsSync)
      await tx.githubResourceSyncJob.create({
        data: { registryId: source.id, generation: source.generation },
      });
  });
}
