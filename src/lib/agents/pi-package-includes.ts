/** Shared immutable package projection, independent of query/execution services. */
export const AGENT_PI_PACKAGES_INCLUDE = {
  orderBy: { marketInstallId: "asc" },
  select: {
    marketInstallId: true,
    releaseId: true,
    marketInstall: {
      select: {
        id: true,
        targetWorkspaceId: true,
        listingId: true,
        status: true,
        resourceMap: true,
        listing: { select: { id: true, kind: true, status: true } },
      },
    },
    release: {
      select: {
        id: true,
        listingId: true,
        reviewStatus: true,
        checksum: true,
        manifest: true,
      },
    },
  },
} as const;
