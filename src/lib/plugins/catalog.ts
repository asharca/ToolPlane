import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import { readPluginChangelog } from "./changelog";

export class PluginError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "PluginError";
  }
}

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

export async function requirePluginWorkspace(
  workspaceId: string,
  userId: string,
  mutate = false,
  client: Prisma.TransactionClient = db,
) {
  const workspace = await client.workspace.findFirst({
    where: {
      id: workspaceId,
      status: "active",
      OR: [
        { ownerId: userId, owner: { status: "active" } },
        {
          members: {
            some: {
              userId,
              user: { status: "active" },
              ...(mutate ? { role: { in: ["owner", "admin"] } } : {}),
            },
          },
        },
      ],
    },
    select: { id: true },
  });
  if (!workspace)
    throw new PluginError("not_authorized", "Workspace access denied.", 403);
  return workspace;
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
    },
  },
} as const;

export async function listPlugins(
  workspaceId: string,
  userId: string,
  options: { sourceId?: string; query?: string; installedOnly?: boolean } = {},
) {
  await requirePluginWorkspace(workspaceId, userId);
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
      releases: {
        where: { reviewStatus: "approved" },
        orderBy: { version: "desc" },
        take: 1,
      },
      installs: {
        where: { targetWorkspaceId: workspaceId, status: "ready" },
        include: { currentRelease: true },
      },
    },
  });
  const items = listings.map(({ releases, installs, ...listing }) => ({
    ...listing,
    latestRelease: releases[0] ?? null,
    install: installs[0] ?? null,
    updateAvailable:
      listing.status === "published" &&
      !!installs[0] &&
      !!releases[0] &&
      installs[0].currentReleaseId !== releases[0].id,
  }));
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

export async function getPlugin(
  workspaceId: string,
  userId: string,
  listingId: string,
) {
  await requirePluginWorkspace(workspaceId, userId);
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
      releases: {
        where: { reviewStatus: "approved" },
        orderBy: { version: "desc" },
      },
      installs: {
        where: { targetWorkspaceId: workspaceId, status: "ready" },
        include: {
          currentRelease: true,
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
  return {
    ...listing,
    releases,
    latestRelease: releases[0] ?? null,
    install: installs[0] ?? null,
    updateAvailable:
      plugin.status === "published" &&
      !!installs[0] &&
      !!plugin.releases[0] &&
      installs[0].currentReleaseId !== plugin.releases[0].id,
  };
}
