import "server-only";
import type { WorkspaceScope } from "@/lib/workspace/scope";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import { readPluginChangelog } from "./changelog";
import { evaluatePluginEnvStatus } from "./env-schema";
import {
  isOfficialRegistrySource,
  resolveListingInstallEnvStatus,
} from "./env-store";
import { PluginError } from "./errors";

export { PluginError };

/** Source semver captured at index time; the integer release version is internal. */
export function pluginReleaseLabel(release: {
  version: number;
  releaseSummary: unknown;
}): string {
  const summary = release.releaseSummary;
  if (
    summary &&
    typeof summary === "object" &&
    "version" in summary &&
    typeof summary.version === "string"
  )
    return summary.version;
  return String(release.version);
}

export function visiblePluginWhere(
  workspaceId: string,
): Prisma.MarketListingWhereInput {
  return {
    kind: "pi-package",
    OR: [
      {
        githubRegistryResource: {
          registry: { official: true, workspaceId: null },
        },
      },
      { publisherWorkspaceId: workspaceId },
    ],
  };
}

const sourceSelect = {
  resourceId: true,
  registry: {
    select: {
      id: true,
      name: true,
      repository: true,
      branch: true,
      official: true,
      workspaceId: true,
    },
  },
} as const;

export async function listPlugins(
  scope: WorkspaceScope,
  options: { sourceId?: string; query?: string; installedOnly?: boolean } = {},
) {
  const { id: workspaceId } = scope;

  const listings = await db.marketListing.findMany({
    where: {
      ...visiblePluginWhere(workspaceId),
      ...(options.installedOnly
        ? {
            installs: {
              some: { targetWorkspaceId: workspaceId, status: "ready" },
            },
          }
        : { status: "published" }),
      ...(options.sourceId
        ? { githubRegistryResource: { registryId: options.sourceId } }
        : {}),
      ...(options.query
        ? {
            AND: [
              {
                OR: [
                  { name: { contains: options.query, mode: "insensitive" } },
                  { summary: { contains: options.query, mode: "insensitive" } },
                ],
              },
            ],
          }
        : {}),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    include: {
      githubRegistryResource: { select: sourceSelect },
      officialEnvPreset: {
        select: { configuredKeys: true, updatedAt: true },
      },
      releases: {
        where: { reviewStatus: "approved" },
        orderBy: { version: "desc" },
        take: 1,
      },
      installs: {
        where: { targetWorkspaceId: workspaceId, status: "ready" },
        include: {
          currentRelease: true,
          envConfig: {
            select: { mode: true, configuredKeys: true, updatedAt: true },
          },
          _count: {
            select: { agentPiPackages: { where: { agent: { workspaceId } } } },
          },
        },
      },
    },
  });
  const items = listings.map(({ releases, installs, ...listing }) => {
    const latestRelease = releases[0] ?? null;
    const install = installs[0] ?? null;
    const activeRelease = install?.currentRelease ?? latestRelease;
    const envStatus = activeRelease
      ? resolveListingInstallEnvStatus({
          manifest: activeRelease.manifest,
          checksum: activeRelease.checksum,
          isOfficial: isOfficialRegistrySource(
            listing.githubRegistryResource?.registry,
          ),
          presetConfiguredKeys: listing.officialEnvPreset?.configuredKeys,
          installedMode: install?.envConfig?.mode ?? null,
          customConfiguredKeys: install?.envConfig?.configuredKeys,
        })
      : evaluatePluginEnvStatus({ isOfficial: false });
    return {
      ...listing,
      latestRelease,
      install,
      envStatus,
      updateAvailable:
        listing.status === "published" &&
        !!install &&
        !!latestRelease &&
        install.currentReleaseId !== latestRelease.id,
    };
  });
  const installed = await db.marketInstall.findMany({
    where: {
      targetWorkspaceId: workspaceId,
      status: "ready",
      listing: { ...visiblePluginWhere(workspaceId), status: "published" },
    },
    select: {
      currentReleaseId: true,
      listing: {
        select: {
          releases: {
            where: { reviewStatus: "approved" },
            orderBy: { version: "desc" },
            take: 1,
            select: { id: true },
          },
        },
      },
    },
  });
  const updateCount = installed.filter(
    (item) =>
      item.listing.releases[0] &&
      item.currentReleaseId !== item.listing.releases[0].id,
  ).length;
  return { items, updateCount };
}

/** Catalog-only enrichment; selectors and badge APIs retain the lightweight list. */
export async function listPluginCards(
  scope: WorkspaceScope,
  options: Parameters<typeof listPlugins>[1] = {},
) {
  const { id: workspaceId } = scope;
  const catalog = await listPlugins(scope, options);
  const installIds = catalog.items.flatMap((item) =>
    item.install ? [item.install.id] : [],
  );
  const bindings = installIds.length
    ? await db.marketInstall.findMany({
        where: { id: { in: installIds }, targetWorkspaceId: workspaceId },
        select: {
          id: true,
          _count: {
            select: { agentPiPackages: { where: { agent: { workspaceId } } } },
          },
        },
      })
    : [];
  const bindingCounts = new Map(
    bindings.map((install) => [install.id, install._count.agentPiPackages]),
  );
  const items = catalog.items.map((listing) => {
    // Installed cards describe their pin, never the newest catalog version.
    const release = listing.install?.currentRelease ?? listing.latestRelease;
    const manifest = release
      ? parsePiPackageReleaseManifest(release.manifest, release.checksum)
      : null;
    const snapshot = manifest?.package;
    return {
      ...listing,
      card: {
        summary: manifest?.listing.summary ?? null,
        version: snapshot?.version ?? null,
        revision: release?.version ?? null,
        runtime: snapshot?.runtime ?? null,
        resources: snapshot
          ? Object.entries(snapshot.resources)
              .map(([kind, paths]) => ({
                kind,
                count: paths?.length ?? 0,
              }))
              .filter((resource) => resource.count > 0)
          : [],
        mcpCount: snapshot?.toolplane?.mcp.length ?? 0,
        agentBindingCount: listing.install
          ? (bindingCounts.get(listing.install.id) ?? 0)
          : 0,
        available:
          listing.status === "published" &&
          release?.reviewStatus === "approved" &&
          (!listing.install || listing.envStatus.complete),
        envComplete: listing.envStatus.complete,
        requiresEnv: listing.envStatus.requiresEnv,
        presetComplete: listing.envStatus.presetComplete,
        revoked: release?.reviewStatus === "revoked",
      },
    };
  });
  return { ...catalog, items };
}

export async function getPlugin(scope: WorkspaceScope, listingId: string) {
  const { id: workspaceId } = scope;

  const plugin = await db.marketListing.findFirst({
    where: {
      id: listingId,
      AND: [
        visiblePluginWhere(workspaceId),
        {
          OR: [
            { status: "published" },
            {
              installs: {
                some: { targetWorkspaceId: workspaceId, status: "ready" },
              },
            },
          ],
        },
      ],
    },
    include: {
      githubRegistryResource: { select: sourceSelect },
      officialEnvPreset: {
        select: { configuredKeys: true, updatedAt: true },
      },
      releases: {
        where: { reviewStatus: "approved" },
        orderBy: { version: "desc" },
      },
      installs: {
        where: { targetWorkspaceId: workspaceId, status: "ready" },
        include: {
          currentRelease: true,
          envConfig: {
            select: { mode: true, configuredKeys: true, updatedAt: true },
          },
          agentPiPackages: {
            where: { agent: { workspaceId } },
            select: {
              agentId: true,
              releaseId: true,
              syncStatus: true,
              targetReleaseId: true,
              syncError: true,
              agent: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  });
  if (!plugin) throw new PluginError("not_found", "Plugin not found.", 404);
  const { installs, releases: storedReleases, ...listing } = plugin;
  const releases = storedReleases.map((release) => ({
    ...release,
    changelog: readPluginChangelog(
      parsePiPackageReleaseManifest(release.manifest, release.checksum).package,
      release.releaseNotes,
    ),
  }));
  const install = installs[0] ?? null;
  const latestRelease = releases[0] ?? null;
  const activeRelease = install?.currentRelease ?? latestRelease;
  const isOfficial = isOfficialRegistrySource(
    listing.githubRegistryResource?.registry,
  );
  const envStatus = activeRelease
    ? resolveListingInstallEnvStatus({
        manifest: activeRelease.manifest,
        checksum: activeRelease.checksum,
        isOfficial,
        presetConfiguredKeys: listing.officialEnvPreset?.configuredKeys,
        installedMode: install?.envConfig?.mode ?? null,
        customConfiguredKeys: install?.envConfig?.configuredKeys,
      })
    : null;
  return {
    ...listing,
    releases,
    latestRelease,
    install,
    envStatus,
    updateAvailable:
      plugin.status === "published" &&
      !!install &&
      !!plugin.releases[0] &&
      install.currentReleaseId !== plugin.releases[0].id,
  };
}
