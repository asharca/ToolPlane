import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma, GithubResourceRegistry } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { logSystemEvent } from "@/lib/observability/system";
import {
  runtimeIsReady,
  trackRuntimeOperation,
} from "@/lib/runtime/ownership-state";
import { decryptSecretText } from "@/lib/security/secrets";
import {
  scanMarketArtifact,
  type MarketSecretScan,
} from "@/lib/pi-packages/secret-scan";
import { marketReleaseChecksum } from "@/lib/pi-packages/artifact";
import { captureGithubRegistryPiPackage } from "@/lib/pi-packages/source";
import {
  parsePiPackageReleaseManifest,
  projectPiPackageSummary,
  scanPiPackageReleaseManifest,
  type PiPackageManifestV1,
} from "@/lib/pi-packages/manifest";
import { computePluginCapabilities } from "./capabilities";
import { readPluginChangelog } from "./changelog";
import {
  GithubRegistryError,
  GithubRegistryTransport,
  parseJsonFile,
  type GithubRegistryEntry,
} from "./github";
import type { PluginSourceSyncSummary } from "./source-sync-types";

type GithubFile = { path: string; data: Buffer; executable?: boolean };
const packageMetadataSchema = z.object({
  name: z.string().min(1).max(240),
  version: z
    .string()
    .max(128)
    .regex(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    ),
  displayName: z.string().min(1).max(240).optional(),
  description: z.string().max(4000).optional(),
  keywords: z.array(z.string().max(64)).max(20).optional(),
});
const listingMetadataSchema = z
  .object({
    name: z.string().min(1).max(240),
    summary: z.string().max(4000),
    iconUrl: z.string().url().max(2000).optional(),
    tags: z.array(z.string().min(1).max(64)).max(20).optional(),
  })
  .strict();
function directoryDigest(
  repository: string,
  path: string,
  files: GithubFile[],
) {
  const hash = createHash("sha256").update(
    JSON.stringify([repository.toLowerCase(), path, "pi-package"]),
  );
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path)))
    hash
      .update(
        JSON.stringify([file.path, file.data.length, file.executable ?? false]),
      )
      .update(file.data);
  return hash.digest("hex");
}

type Prepared = {
  entry: GithubRegistryEntry;
  version: string;
  digest: string;
  manifest?: PiPackageManifestV1;
  releaseNotes?: string | null;
  scanResult?: MarketSecretScan;
};

class RegistryEntrySyncError extends Error {
  readonly failedPath: string | null;

  constructor(path: string, token: string | undefined, cause: unknown) {
    super("Registry entry sync failed", { cause });
    this.failedPath =
      (token && path.includes(token)) ||
      scanMarketArtifact(path).status === "blocked"
        ? null
        : path;
  }
}

async function prepare(
  registry: GithubResourceRegistry,
  transport: GithubRegistryTransport,
  commit: string,
  token?: string,
) {
  async function prepareEntry(entry: GithubRegistryEntry) {
    const files = await transport.directory(
      registry.repository,
      commit,
      entry.path,
    );
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
    const packageFile = files.find((file) => file.path === "package.json");
    if (!packageFile) throw new GithubRegistryError("plugin_package_missing");
    const pkg = packageMetadataSchema.safeParse(
      parseJsonFile(packageFile.data),
    );
    if (!pkg.success) throw new GithubRegistryError("plugin_package_invalid");
    const digest = directoryDigest(registry.repository, entry.path, files);
    const previous = await db.githubRegistryResource.findUnique({
      where: {
        registryId_resourceId: {
          registryId: registry.id,
          resourceId: entry.id,
        },
      },
      include: { versions: { where: { version: pkg.data.version } } },
    });
    const version = previous?.versions[0];
    if (version && version.digest !== digest)
      throw new GithubRegistryError("resource_version_conflict");
    const prepared: Prepared = { entry, version: pkg.data.version, digest };
    if (!version?.releaseId) {
      const descriptor = files.find(
        (file) => file.path === "toolplane.plugin.json",
      );
      const metadata = descriptor
        ? listingMetadataSchema.safeParse(parseJsonFile(descriptor.data))
        : null;
      if (metadata && !metadata.success)
        throw new GithubRegistryError("plugin_metadata_invalid");
      const listing = {
        slug: entry.id,
        name: metadata?.data?.name ?? pkg.data.displayName ?? pkg.data.name,
        summary: metadata?.data?.summary ?? pkg.data.description ?? null,
        iconUrl: metadata?.data?.iconUrl ?? null,
        tags: metadata?.data?.tags ?? pkg.data.keywords ?? [],
        author: registry.repository.split("/")[0],
      };
      const snapshot = await captureGithubRegistryPiPackage({
        repository: registry.repository,
        commit,
        path: entry.path,
        files,
      });
      const manifest = parsePiPackageReleaseManifest({
        schemaVersion: 1,
        kind: "pi-package",
        listing,
        package: snapshot,
      });
      const changelog = readPluginChangelog(manifest.package);
      prepared.releaseNotes =
        changelog?.kind === "release-notes" ? changelog.text : null;
      prepared.scanResult = scanPiPackageReleaseManifest(
        manifest,
        prepared.releaseNotes,
      );
      if (prepared.scanResult.status === "blocked")
        throw new GithubRegistryError("resource_secrets_detected");
      prepared.manifest = manifest;
    }
    return prepared;
  }

  const index = await transport.index(registry.repository, commit);
  const prepared: Prepared[] = [];
  for (const entry of index.plugins) {
    try {
      prepared.push(await prepareEntry(entry));
    } catch (error) {
      throw new RegistryEntrySyncError(entry.path, token, error);
    }
  }
  const unregistered = await transport.unregisteredDirectories(
    registry.repository,
    commit,
    index.plugins.map((entry) => entry.path),
  );
  return { prepared, unregistered };
}

async function publish(
  registry: GithubResourceRegistry,
  jobId: string,
  generation: number,
  leaseToken: string,
  commit: string,
  prepared: Prepared[],
  unregistered: string[],
  token?: string,
) {
  let entryPath: string | null = null;
  return db
    .$transaction(
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
        const summary: PluginSourceSyncSummary = {
          resourceCount: prepared.length,
          added: [],
          updated: [],
          removed: [],
          unregistered,
        };
        for (const item of prepared) {
          entryPath = item.entry.path;
          let resource = await tx.githubRegistryResource.findUnique({
            where: {
              registryId_resourceId: {
                registryId: registry.id,
                resourceId: item.entry.id,
              },
            },
          });
          const wasActive = resource?.active === true;
          const previous = resource
            ? await tx.githubRegistryVersion.findUnique({
                where: {
                  resourceId_version: {
                    resourceId: resource.id,
                    version: item.version,
                  },
                },
              })
            : null;
          if (previous && previous.digest !== item.digest)
            throw new GithubRegistryError("resource_version_conflict");
          let listingId = resource?.listingId;
          if (!listingId) {
            if (!item.manifest)
              throw new GithubRegistryError("resource_artifact_missing");
            const listing = await tx.marketListing.create({
              data: {
                kind: "pi-package",
                namespace: registry.official
                  ? "official"
                  : `github-${registry.id}`,
                slug: item.entry.id,
                publisherKind: registry.official ? "official" : "workspace",
                publisherWorkspaceId: registry.workspaceId,
                publishedById: registry.createdById,
                visibility: registry.official ? "public" : "private",
                status: "published",
                name: item.manifest.listing.name,
                summary: item.manifest.listing.summary,
                iconUrl: item.manifest.listing.iconUrl,
                tags: item.manifest.listing.tags,
                metadata: {},
              },
            });
            listingId = listing.id;
          }
          resource = resource
            ? await tx.githubRegistryResource.update({
                where: { id: resource.id },
                data: { listingId, active: true, kind: "pi-package" },
              })
            : await tx.githubRegistryResource.create({
                data: {
                  registryId: registry.id,
                  resourceId: item.entry.id,
                  listingId,
                  kind: "pi-package",
                },
              });
          let releaseId = previous?.releaseId;
          const needsRelease = !releaseId;
          if (!releaseId) {
            if (!item.manifest || !item.scanResult)
              throw new GithubRegistryError("resource_artifact_missing");
            const manifest = item.manifest;
            const latest = await tx.marketRelease.aggregate({
              where: { listingId },
              _max: { version: true },
            });
            const release = await tx.marketRelease.create({
              data: {
                listingId,
                version: (latest._max.version ?? 0) + 1,
                manifest: manifest as Prisma.InputJsonValue,
                releaseNotes: item.releaseNotes,
                releaseSummary: {
                  ...projectPiPackageSummary(manifest.package),
                  source: {
                    repository: registry.repository,
                    commit,
                    path: item.entry.path,
                    version: item.version,
                  },
                  capabilities: computePluginCapabilities(manifest),
                } as unknown as Prisma.InputJsonValue,
                checksum: marketReleaseChecksum(manifest),
                scanResult: item.scanResult,
                reviewStatus: "approved",
                reviewedAt: new Date(),
                reviewedById: registry.createdById,
                reviewNote: "Secret-scanned GitHub plugin",
                publishedAt: new Date(),
              },
            });
            releaseId = release.id;
            if (previous)
              await tx.githubRegistryVersion.update({
                where: { id: previous.id },
                data: { releaseId },
              });
            else
              await tx.githubRegistryVersion.create({
                data: {
                  resourceId: resource.id,
                  version: item.version,
                  digest: item.digest,
                  sourceRepository: registry.repository,
                  sourceCommit: commit,
                  sourcePath: item.entry.path,
                  releaseId,
                },
              });
          }
          const release = await tx.marketRelease.findUniqueOrThrow({
            where: { id: releaseId },
          });
          const manifest = parsePiPackageReleaseManifest(
            release.manifest,
            release.checksum,
          );
          const changes = !wasActive
            ? summary.added
            : needsRelease
              ? summary.updated
              : null;
          if (changes && changes.length < 200) {
            changes.push({
              id: item.entry.id,
              name: manifest.listing.name,
              version: item.version,
            });
          }
          await tx.marketListing.update({
            where: { id: listingId },
            data: {
              name: manifest.listing.name,
              summary: manifest.listing.summary,
              iconUrl: manifest.listing.iconUrl,
              tags: manifest.listing.tags,
              metadata: {
                author: manifest.listing.author,
                repository: registry.repository,
                commit,
                path: item.entry.path,
                version: item.version,
              },
              latestReleaseId: release.id,
              latestVersion: release.version,
              visibility: registry.official ? "public" : "private",
              publishedAt: new Date(),
            },
          });
          // Source sync may restore a removed entry, but must never undo an administrator's take-down.
          await tx.marketListing.updateMany({
            where: { id: listingId, status: { not: "withdrawn" } },
            data: { status: "published" },
          });
        }
        entryPath = null;
        const removed = await tx.githubRegistryResource.findMany({
          where: {
            registryId: registry.id,
            resourceId: { notIn: prepared.map((item) => item.entry.id) },
            active: true,
          },
          orderBy: { resourceId: "asc" },
          include: { listing: { select: { name: true } } },
        });
        summary.removed = removed.slice(0, 200).map((item) => ({
          id: item.resourceId,
          name: item.listing?.name ?? item.resourceId,
        }));
        await tx.marketListing.updateMany({
          where: {
            id: {
              in: removed.flatMap((item) =>
                item.listingId ? [item.listingId] : [],
              ),
            },
            status: { not: "withdrawn" },
          },
          data: { status: "removed" },
        });
        await tx.githubRegistryResource.updateMany({
          where: { id: { in: removed.map((item) => item.id) } },
          data: { active: false },
        });
        const completed = await tx.githubResourceSyncJob.updateMany({
          where: { id: jobId, leaseToken, status: "running" },
          data: {
            status: "succeeded",
            commit,
            summary,
            finishedAt: new Date(),
            error: null,
            leaseToken: null,
          },
        });
        if (!completed.count)
          throw new GithubRegistryError("registry_source_changed");
      },
      { timeout: 30_000 },
    )
    .catch((error) => {
      if (entryPath !== null)
        throw new RegistryEntrySyncError(entryPath, token, error);
      throw error;
    });
}
let processing = false;
export async function runPendingGithubResourceSyncJobs() {
  if (processing || !runtimeIsReady()) return 0;
  processing = true;
  let processed = 0;
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
        processed += 1;
        const started = Date.now();
        const heartbeat = setInterval(() => {
          if (!runtimeIsReady()) return;
          void db.githubResourceRegistry
            .updateMany({
              where: { id: registry.id, leaseToken },
              data: { leaseExpiresAt: new Date(Date.now() + 120_000) },
            })
            .catch((error) => {
              logSystemEvent("plugins.registry.lease_renewal_failed", {
                error,
                errorCode: "REGISTRY_LEASE_RENEWAL_FAILED",
                workspaceId: registry.workspaceId ?? undefined,
                attributes: { sourceId: registry.id },
              });
            });
        }, 20_000);
        heartbeat.unref?.();
        try {
          const token = registry.official
            ? process.env.TOOLPLANE_OFFICIAL_PLUGIN_TOKEN || undefined
            : registry.credentials
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
          const { prepared, unregistered } = await prepare(
            registry,
            transport,
            commit,
            token,
          );
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
            unregistered,
            token,
          );
          logSystemEvent("plugins.registry.synced", {
            workspaceId: registry.workspaceId ?? undefined,
            durationMs: Date.now() - started,
            attributes: {
              sourceId: registry.id,
              resourceCount: prepared.length,
              releaseCount: prepared.filter((item) => item.manifest).length,
            },
          });
        } catch (error) {
          const entryError =
            error instanceof RegistryEntrySyncError ? error : null;
          const cause = entryError ? entryError.cause : error;
          const code =
            cause instanceof GithubRegistryError
              ? cause.code
              : "registry_sync_failed";
          logSystemEvent("plugins.registry.sync_failed", {
            error: cause,
            errorCode: code.toUpperCase(),
            workspaceId: registry.workspaceId ?? undefined,
            durationMs: Date.now() - started,
            attributes: { sourceId: registry.id },
          });
          await db.$transaction(async (tx) => {
            // Match the registry-first lock order used by claims and enqueueing.
            const [current] = await tx.$queryRaw<{ generation: number }[]>`
              SELECT "generation" FROM "GithubResourceRegistry"
              WHERE "id" = ${registry.id} FOR UPDATE
            `;
            const failed = await tx.githubResourceSyncJob.updateMany({
              where: { id: job.id, status: "running", leaseToken },
              data: {
                status: "failed",
                error: code,
                failedPath: entryError?.failedPath ?? null,
                finishedAt: new Date(),
                leaseToken: null,
              },
            });
            let retry = false;
            if (
              failed.count > 0 &&
              code === "registry_source_changed" &&
              current?.generation === job.generation
            ) {
              // The current failure counts toward the three-job cutoff.
              const recent = await tx.githubResourceSyncJob.findMany({
                where: { registryId: registry.id },
                orderBy: [
                  { generation: "desc" },
                  { createdAt: "desc" },
                  { id: "desc" },
                ],
                take: 3,
                select: { status: true, error: true },
              });
              retry =
                recent.length < 3 ||
                recent.some(
                  (attempt) =>
                    attempt.status !== "failed" || attempt.error !== code,
                );
            }
            const changed = await tx.githubResourceRegistry.updateMany({
              where: {
                id: registry.id,
                leaseToken,
                generation: job.generation,
                status: { not: "disabled" },
              },
              data: {
                status: retry ? "pending" : "error",
                error: retry ? null : code,
                ...(retry ? { generation: { increment: 1 } } : {}),
                leaseToken: null,
                leaseExpiresAt: null,
              },
            });
            if (!changed.count) {
              // A newer generation owns the status; only release this job's lease.
              await tx.githubResourceRegistry.updateMany({
                where: { id: registry.id, leaseToken },
                data: { leaseToken: null, leaseExpiresAt: null },
              });
            } else if (retry) {
              await tx.githubResourceSyncJob.create({
                data: {
                  registryId: registry.id,
                  generation: job.generation + 1,
                },
              });
              await tx.githubResourceSyncJob.update({
                where: { id: job.id },
                data: { retried: true },
              });
            }
          });
        } finally {
          clearInterval(heartbeat);
        }
      }
    });
    return processed;
  } finally {
    processing = false;
  }
}
