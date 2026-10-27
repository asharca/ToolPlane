import "server-only";

import { createHmac, randomUUID } from "node:crypto";
import { Prisma, type GithubResourceRegistry } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  runtimeIsReady,
  trackRuntimeOperation,
} from "@/lib/runtime/ownership-state";
import { decryptSecretText, encryptSecretText } from "@/lib/security/secrets";
import { scanMarketArtifact } from "@/lib/market/secret-scan";
import {
  buildGithubRegistryRelease,
  githubDirectoryDigest,
  type GithubRegistryArtifact,
} from "./github-registry-manifest";
import {
  buildGithubRegistryAgentRelease,
  publishGithubRegistryAgentRelease,
  type GithubRegistryAgentArtifact,
} from "./github-registry-agent";
import {
  branchSchema,
  GithubRegistryError,
  GithubRegistryTransport,
  parseJsonFile,
  repositorySchema,
  type GithubRegistryEntry,
} from "./github-registry-source";

export { GithubRegistryError } from "./github-registry-source";
const registrationSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    repository: repositorySchema.transform((value) => value.toLowerCase()),
    branch: branchSchema,
    visibility: z.enum(["public", "private"]),
    token: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .regex(/^[A-Za-z0-9_]+$/)
      .optional(),
  })
  .strict();
async function authorize(workspaceId: string, userId: string, manage = false) {
  const workspace = await db.workspace.findFirst({
    where: {
      id: workspaceId,
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
/** The master never leaves this process; each registry receives an isolated webhook key. */
export function deriveGithubResourceRegistryWebhookSecret(registry: {
  id: string;
  workspaceId: string;
}) {
  const master = process.env.TOOLPLANE_RESOURCE_REGISTRY_WEBHOOK_SECRET;
  if (!master) throw new GithubRegistryError("webhook_not_configured");
  return createHmac("sha256", master)
    .update("toolplane:resource-registry:webhook:v1\0")
    .update(JSON.stringify([registry.workspaceId, registry.id]))
    .digest("hex");
}
export type GithubResourceRegistryWebhookConfiguration = {
  path: string;
  secret: string;
};
export async function getGithubResourceRegistryWebhookConfiguration(input: {
  workspaceId: string;
  userId: string;
  registryId: string;
}): Promise<GithubResourceRegistryWebhookConfiguration> {
  await authorize(input.workspaceId, input.userId, true);
  const registry = await db.githubResourceRegistry.findFirst({
    where: {
      id: input.registryId,
      workspaceId: input.workspaceId,
      status: { not: "disabled" },
    },
    select: { id: true, workspaceId: true },
  });
  if (!registry) throw new GithubRegistryError("registry_not_found");
  return {
    path: `/api/v1/resource-registries/${registry.id}/webhook`,
    secret: deriveGithubResourceRegistryWebhookSecret(registry),
  };
}
export async function listGithubResourceRegistries(input: {
  workspaceId: string;
  userId: string;
}) {
  await authorize(input.workspaceId, input.userId);
  const rows = await db.githubResourceRegistry.findMany({
    where: { workspaceId: input.workspaceId, status: { not: "disabled" } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      repository: true,
      branch: true,
      visibility: true,
      status: true,
      lastAppliedCommit: true,
      lastSyncAt: true,
      error: true,
      credentials: true,
    },
  });
  return rows.map(({ credentials, ...row }) => ({
    ...row,
    hasCredentials: credentials !== null,
  }));
}
export async function createGithubResourceRegistry(input: {
  workspaceId: string;
  userId: string;
  name: string;
  repository: string;
  branch: string;
  visibility: string;
  token?: string;
}) {
  await authorize(input.workspaceId, input.userId, true);
  const parsed = registrationSchema.safeParse({
    name: input.name,
    repository: input.repository || "asharca/toolplane-resources",
    branch: input.branch || "main",
    visibility: input.visibility,
    ...(input.token ? { token: input.token } : {}),
  });
  if (!parsed.success)
    throw new GithubRegistryError("registry_configuration_invalid");
  const transport = new GithubRegistryTransport(
    parsed.data.repository,
    parsed.data.token,
    parsed.data.visibility,
  );
  await transport.assertAccess(parsed.data.repository);
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.githubResourceRegistry.findUnique({
        where: {
          workspaceId_repository_branch: {
            workspaceId: input.workspaceId,
            repository: parsed.data.repository,
            branch: parsed.data.branch,
          },
        },
      });
      if (existing && existing.status !== "disabled")
        throw new GithubRegistryError("registry_already_registered");
      const configuration = {
        createdById: input.userId,
        name: parsed.data.name,
        visibility: parsed.data.visibility,
        credentials: parsed.data.token
          ? encryptSecretText(parsed.data.token)
          : Prisma.DbNull,
        status: "pending",
        error: null,
      };
      const registry = existing
        ? await tx.githubResourceRegistry.update({
            where: { id: existing.id },
            data: { ...configuration, generation: { increment: 1 } },
          })
        : await tx.githubResourceRegistry.create({
            data: {
              ...configuration,
              workspaceId: input.workspaceId,
              repository: parsed.data.repository,
              branch: parsed.data.branch,
              generation: 1,
            },
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
async function enqueue(registryId: string, deliveryId?: string) {
  return db.$transaction(async (tx) => {
    // Serialize generation allocation, webhook replay and job creation on this source.
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
export async function requestGithubResourceSync(input: {
  workspaceId: string;
  userId: string;
  registryId: string;
}) {
  await authorize(input.workspaceId, input.userId, true);
  if (
    !(await db.githubResourceRegistry.findFirst({
      where: {
        id: input.registryId,
        workspaceId: input.workspaceId,
        status: { not: "disabled" },
      },
      select: { id: true },
    }))
  )
    throw new GithubRegistryError("registry_not_found");
  return enqueue(input.registryId);
}
export async function updateGithubResourceRegistryCredentials(input: {
  workspaceId: string;
  userId: string;
  registryId: string;
  token: string;
}) {
  await authorize(input.workspaceId, input.userId, true);
  const registry = await db.githubResourceRegistry.findFirst({
    where: {
      id: input.registryId,
      workspaceId: input.workspaceId,
      status: { not: "disabled" },
    },
  });
  if (!registry) throw new GithubRegistryError("registry_not_found");
  const token = input.token.trim();
  if (!/^[A-Za-z0-9_]{1,4096}$/.test(token))
    throw new GithubRegistryError("registry_configuration_invalid");
  await new GithubRegistryTransport(
    registry.repository,
    token,
    registry.visibility,
  ).assertAccess(registry.repository);
  return db.$transaction(async (tx) => {
    const changed = await tx.githubResourceRegistry.updateMany({
      where: {
        id: registry.id,
        workspaceId: input.workspaceId,
        status: { not: "disabled" },
      },
      data: {
        credentials: encryptSecretText(token),
        generation: { increment: 1 },
        status: "pending",
        error: null,
      },
    });
    if (!changed.count) throw new GithubRegistryError("registry_not_found");
    const updated = await tx.githubResourceRegistry.findUniqueOrThrow({
      where: { id: registry.id },
    });
    return tx.githubResourceSyncJob.create({
      data: { registryId: updated.id, generation: updated.generation },
      select: { id: true },
    });
  });
}
// A disabled registry withdraws discoverability, never historical artifacts or pins.
export async function deleteGithubResourceRegistry(input: {
  workspaceId: string;
  userId: string;
  registryId: string;
}) {
  await authorize(input.workspaceId, input.userId, true);
  await db.$transaction(async (tx) => {
    const changed = await tx.githubResourceRegistry.updateMany({
      where: { id: input.registryId, workspaceId: input.workspaceId },
      data: {
        status: "disabled",
        generation: { increment: 1 },
        credentials: Prisma.DbNull,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (!changed.count) throw new GithubRegistryError("registry_not_found");
    const resources = await tx.githubRegistryResource.findMany({
      where: { registryId: input.registryId },
    });
    await tx.marketListing.updateMany({
      where: {
        status: { not: "disabled" },
        id: {
          in: resources.flatMap((resource) =>
            resource.listingId ? [resource.listingId] : [],
          ),
        },
      },
      data: { status: "draft" },
    });
    await tx.agentListing.updateMany({
      where: {
        status: { not: "disabled" },
        id: {
          in: resources.flatMap((resource) =>
            resource.agentListingId ? [resource.agentListingId] : [],
          ),
        },
      },
      data: { status: "draft" },
    });
    await tx.githubRegistryResource.updateMany({
      where: { registryId: input.registryId },
      data: { active: false },
    });
    await tx.githubResourceSyncJob.updateMany({
      where: {
        registryId: input.registryId,
        status: { in: ["pending", "running"] },
      },
      data: { status: "cancelled", finishedAt: new Date() },
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
  return enqueue(input.registryId, input.deliveryId);
}

type Prepared = {
  entry: GithubRegistryEntry;
  repository: string;
  commit: string;
  path: string;
  digest: string;
  artifact?: GithubRegistryArtifact;
  agentArtifact?: GithubRegistryAgentArtifact;
};
async function prepare(
  registry: GithubResourceRegistry,
  transport: GithubRegistryTransport,
  commit: string,
  token?: string,
) {
  const index = await transport.index(registry.repository, commit);
  const results: Prepared[] = [];
  for (const entry of index.resources) {
    const source = entry.source ?? {
      repository: registry.repository,
      commit,
      path: entry.path,
    };
    const files = await transport.directory(
      source.repository,
      source.commit,
      source.path,
    );
    // Scan the complete source before any executable package capture, including ignored files.
    const scan = scanMarketArtifact(
      null,
      null,
      files.map((file) => ({
        path: file.path,
        content: file.data.toString("utf8"),
      })),
    );
    if (
      scan.status === "blocked" ||
      (token && files.some((file) => file.data.includes(Buffer.from(token))))
    )
      throw new GithubRegistryError("resource_secrets_detected");
    const digest = githubDirectoryDigest(
      source.repository,
      source.path,
      entry.kind,
      files,
    );
    const previous = await db.githubRegistryResource.findUnique({
      where: {
        registryId_resourceId: {
          registryId: registry.id,
          resourceId: entry.id,
        },
      },
      include: { versions: { where: { version: entry.version } } },
    });
    if (previous && previous.kind !== entry.kind)
      throw new GithubRegistryError("resource_kind_conflict");
    const version = previous?.versions[0];
    if (version && version.digest !== digest)
      throw new GithubRegistryError("resource_version_conflict");
    const prepared: Prepared = { entry, ...source, digest };
    if (!version) {
      if (entry.kind === "agent") {
        const descriptor = files.find((file) => file.path === "resource.json");
        if (!descriptor)
          throw new GithubRegistryError("resource_descriptor_missing");
        prepared.agentArtifact = buildGithubRegistryAgentRelease(
          parseJsonFile(descriptor.data),
        );
      } else {
        prepared.artifact = await buildGithubRegistryRelease({
          entry,
          ...source,
          files,
        });
      }
    }
    results.push(prepared);
  }
  return results;
}
async function publish(
  registry: GithubResourceRegistry,
  jobId: string,
  generation: number,
  leaseToken: string,
  commit: string,
  prepared: Prepared[],
) {
  return db.$transaction(
    async (tx) => {
      const claim = await tx.githubResourceRegistry.updateMany({
        where: {
          id: registry.id,
          generation,
          leaseToken,
          leaseExpiresAt: { gt: new Date() },
          lastAppliedCommit: registry.lastAppliedCommit,
          status: { not: "disabled" },
        },
        data: {
          status: "synced",
          lastAppliedCommit: commit,
          lastSyncAt: new Date(),
          error: null,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (!claim.count)
        throw new GithubRegistryError("registry_source_changed");
      for (const item of prepared) {
        let resource = await tx.githubRegistryResource.findUnique({
          where: {
            registryId_resourceId: {
              registryId: registry.id,
              resourceId: item.entry.id,
            },
          },
        });
        if (resource && resource.kind !== item.entry.kind)
          throw new GithubRegistryError("resource_kind_conflict");
        const previous = resource
          ? await tx.githubRegistryVersion.findUnique({
              where: {
                resourceId_version: {
                  resourceId: resource.id,
                  version: item.entry.version,
                },
              },
            })
          : null;
        if (previous && previous.digest !== item.digest)
          throw new GithubRegistryError("resource_version_conflict");
        let releaseId: string | null = previous?.releaseId ?? null;
        let agentReleaseId: string | null = previous?.agentReleaseId ?? null;
        if (item.entry.kind === "agent") {
          const published = await publishGithubRegistryAgentRelease(tx, {
            workspaceId: registry.workspaceId,
            userId: registry.createdById,
            namespace: `github-${registry.id}`,
            resourceId: item.entry.id,
            artifact: item.agentArtifact,
            agentListingId: resource?.agentListingId ?? undefined,
            agentReleaseId: agentReleaseId ?? undefined,
            visibility: registry.visibility,
          });
          agentReleaseId = published.agentReleaseId;
          if (!resource)
            resource = await tx.githubRegistryResource.create({
              data: {
                registryId: registry.id,
                resourceId: item.entry.id,
                kind: "agent",
                agentListingId: published.agentListingId,
              },
            });
        } else {
          const artifact = item.artifact;
          if (!resource) {
            if (!artifact)
              throw new GithubRegistryError("resource_artifact_missing");
            const listing = await tx.marketListing.create({
              data: {
                kind: item.entry.kind,
                namespace: `github-${registry.id}`,
                slug: item.entry.id,
                publisherKind: "workspace",
                publisherWorkspaceId: registry.workspaceId,
                publishedById: registry.createdById,
                visibility: registry.visibility,
                name: artifact.listing.name,
                summary: artifact.listing.summary,
                iconUrl: artifact.listing.iconUrl,
                tags: artifact.listing.tags,
                metadata: {},
              },
            });
            resource = await tx.githubRegistryResource.create({
              data: {
                registryId: registry.id,
                resourceId: item.entry.id,
                kind: item.entry.kind,
                listingId: listing.id,
              },
            });
          }
          if (!resource.listingId)
            throw new GithubRegistryError("resource_kind_conflict");
          if (!releaseId) {
            if (!artifact)
              throw new GithubRegistryError("resource_artifact_missing");
            const latest = await tx.marketRelease.aggregate({
              where: { listingId: resource.listingId },
              _max: { version: true },
            });
            const release = await tx.marketRelease.create({
              data: {
                listingId: resource.listingId,
                version: (latest._max.version ?? 0) + 1,
                manifest: artifact.manifest as Prisma.InputJsonValue,
                releaseSummary: {
                  ...artifact.summary,
                  registryVersion: item.entry.version,
                  github: {
                    repository: item.repository,
                    commit: item.commit,
                    path: item.path,
                    version: item.entry.version,
                  },
                } as Prisma.InputJsonObject,
                checksum: artifact.checksum,
                scanResult: artifact.scan,
                reviewStatus: "approved",
                reviewedAt: new Date(),
                reviewedById: registry.createdById,
                reviewNote: "GitHub registry administrator trust",
                publishedAt: new Date(),
              },
            });
            releaseId = release.id;
          }
          const release = await tx.marketRelease.findUniqueOrThrow({
            where: { id: releaseId },
          });
          const listing = z
            .object({
              listing: z.object({
                name: z.string(),
                summary: z.string().nullable(),
                iconUrl: z.string().nullable(),
                tags: z.array(z.string()),
                author: z.string(),
              }),
            })
            .parse(release.manifest).listing;
          await tx.marketListing.update({
            where: { id: resource.listingId },
            data: {
              name: listing.name,
              summary: listing.summary,
              iconUrl: listing.iconUrl,
              tags: listing.tags,
              metadata: {
                author: listing.author,
                registryVersion: item.entry.version,
                repository: item.repository,
                commit: item.commit,
                path: item.path,
              },
              latestReleaseId: release.id,
              latestVersion: release.version,
              visibility: registry.visibility,
              publishedAt: new Date(),
            },
          });
          // Synchronization may reactivate source withdrawals, never administrator takedowns.
          await tx.marketListing.updateMany({
            where: { id: resource.listingId, status: { not: "disabled" } },
            data: { status: "published" },
          });
        }
        if (!previous)
          await tx.githubRegistryVersion.create({
            data: {
              resourceId: resource.id,
              version: item.entry.version,
              digest: item.digest,
              sourceRepository: item.repository,
              sourceCommit: item.commit,
              sourcePath: item.path,
              releaseId,
              agentReleaseId,
            },
          });
        await tx.githubRegistryResource.update({
          where: { id: resource.id },
          data: { active: true },
        });
      }
      const withdrawn = await tx.githubRegistryResource.findMany({
        where: {
          registryId: registry.id,
          resourceId: { notIn: prepared.map((item) => item.entry.id) },
          active: true,
        },
      });
      await tx.marketListing.updateMany({
        where: {
          status: { not: "disabled" },
          id: {
            in: withdrawn.flatMap((resource) =>
              resource.listingId ? [resource.listingId] : [],
            ),
          },
        },
        data: { status: "draft" },
      });
      await tx.agentListing.updateMany({
        where: {
          status: { not: "disabled" },
          id: {
            in: withdrawn.flatMap((resource) =>
              resource.agentListingId ? [resource.agentListingId] : [],
            ),
          },
        },
        data: { status: "draft" },
      });
      await tx.githubRegistryResource.updateMany({
        where: { id: { in: withdrawn.map((resource) => resource.id) } },
        data: { active: false },
      });
      const completed = await tx.githubResourceSyncJob.updateMany({
        where: { id: jobId, leaseToken, status: "running" },
        data: {
          status: "succeeded",
          commit,
          finishedAt: new Date(),
          error: null,
          leaseToken: null,
        },
      });
      if (!completed.count)
        throw new GithubRegistryError("registry_source_changed");
    },
    { timeout: 30_000 },
  );
}
let processing = false;
export async function runPendingGithubResourceSyncJobs() {
  if (processing || !runtimeIsReady()) return;
  processing = true;
  try {
    await trackRuntimeOperation(async () => {
      // A crashed owner's lease must expire before its durable running job can be reclaimed.
      await db.githubResourceSyncJob.updateMany({
        where: {
          status: "running",
          registry: {
            leaseExpiresAt: { lt: new Date() },
            status: { not: "disabled" },
          },
        },
        data: { status: "pending", leaseToken: null },
      });
      const jobs = await db.githubResourceSyncJob.findMany({
        where: { status: "pending", registry: { status: { not: "disabled" } } },
        orderBy: { createdAt: "asc" },
        take: 10,
      });
      for (const job of jobs) {
        if (!runtimeIsReady()) break;
        const leaseToken = randomUUID();
        const registry = await db.$transaction(async (tx) => {
          const claimed = await tx.githubResourceRegistry.updateMany({
            where: {
              id: job.registryId,
              status: { not: "disabled" },
              OR: [
                { leaseToken: null },
                { leaseExpiresAt: { lt: new Date() } },
              ],
            },
            data: {
              leaseToken,
              leaseExpiresAt: new Date(Date.now() + 120_000),
            },
          });
          if (!claimed.count) return null;
          const current = await tx.githubResourceRegistry.findUniqueOrThrow({
            where: { id: job.registryId },
          });
          if (current.generation !== job.generation) {
            await tx.githubResourceSyncJob.updateMany({
              where: { id: job.id, status: "pending" },
              data: {
                status: "superseded",
                finishedAt: new Date(),
                leaseToken: null,
              },
            });
            await tx.githubResourceRegistry.update({
              where: { id: current.id },
              data: { leaseToken: null, leaseExpiresAt: null },
            });
            return null;
          }
          const jobClaim = await tx.githubResourceSyncJob.updateMany({
            where: { id: job.id, status: "pending" },
            data: {
              status: "running",
              startedAt: new Date(),
              error: null,
              leaseToken,
            },
          });
          if (!jobClaim.count) {
            await tx.githubResourceRegistry.update({
              where: { id: current.id },
              data: { leaseToken: null, leaseExpiresAt: null },
            });
            return null;
          }
          await tx.githubResourceRegistry.update({
            where: { id: current.id },
            data: { status: "syncing" },
          });
          return current;
        });
        if (!registry) continue;
        const heartbeat = setInterval(() => {
          if (!runtimeIsReady()) return;
          void db.githubResourceRegistry
            .updateMany({
              where: { id: registry.id, leaseToken },
              data: { leaseExpiresAt: new Date(Date.now() + 120_000) },
            })
            .catch(() => undefined);
        }, 20_000);
        heartbeat.unref?.();
        try {
          const token = registry.credentials
            ? decryptSecretText(registry.credentials)
            : undefined;
          const transport = new GithubRegistryTransport(
            registry.repository,
            token,
            registry.visibility,
          );
          await transport.assertAccess(registry.repository);
          const commit = await transport.resolveCommit(
            registry.repository,
            registry.branch,
          );
          await db.githubResourceSyncJob.updateMany({
            where: { id: job.id, leaseToken, status: "running" },
            data: { commit },
          });
          const prepared = await prepare(registry, transport, commit, token);
          if (
            !runtimeIsReady() ||
            (await transport.resolveCommit(
              registry.repository,
              registry.branch,
            )) !== commit
          )
            throw new GithubRegistryError("registry_source_changed");
          await publish(
            registry,
            job.id,
            job.generation,
            leaseToken,
            commit,
            prepared,
          );
        } catch (error) {
          const code =
            error instanceof GithubRegistryError
              ? error.code
              : "registry_sync_failed";
          await db.$transaction(async (tx) => {
            await tx.githubResourceSyncJob.updateMany({
              where: { id: job.id, status: "running", leaseToken },
              data: {
                status: "failed",
                error: code,
                finishedAt: new Date(),
                leaseToken: null,
              },
            });
            const changed = await tx.githubResourceRegistry.updateMany({
              where: {
                id: registry.id,
                leaseToken,
                generation: job.generation,
                status: { not: "disabled" },
              },
              data: {
                status: "error",
                error: code,
                leaseToken: null,
                leaseExpiresAt: null,
              },
            });
            if (!changed.count)
              await tx.githubResourceRegistry.updateMany({
                where: { id: registry.id, leaseToken },
                data: { leaseToken: null, leaseExpiresAt: null },
              });
          });
        } finally {
          clearInterval(heartbeat);
        }
      }
    });
  } finally {
    processing = false;
  }
}
