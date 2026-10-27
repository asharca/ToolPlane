ALTER TABLE "AgentListing" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'public';
ALTER TABLE "AgentRelease" ADD COLUMN "author" TEXT;
-- Credentials are encrypted application-side. Existing immutable releases and install pins are unchanged.
CREATE TABLE "GithubResourceRegistry" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "createdById" TEXT NOT NULL,
  "name" TEXT NOT NULL, "repository" TEXT NOT NULL, "branch" TEXT NOT NULL DEFAULT 'main',
  "visibility" TEXT NOT NULL DEFAULT 'private', "credentials" JSONB, "status" TEXT NOT NULL DEFAULT 'pending',
  "generation" INTEGER NOT NULL DEFAULT 0, "lastAppliedCommit" TEXT, "lastSyncAt" TIMESTAMP(3), "error" TEXT,
  "leaseToken" TEXT, "leaseExpiresAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "GithubResourceRegistry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GithubResourceRegistry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GithubResourceRegistry_workspaceId_repository_branch_key" ON "GithubResourceRegistry"("workspaceId", "repository", "branch");
CREATE INDEX "GithubResourceRegistry_status_leaseExpiresAt_idx" ON "GithubResourceRegistry"("status", "leaseExpiresAt");
CREATE TABLE "GithubResourceSyncJob" (
  "id" TEXT NOT NULL, "registryId" TEXT NOT NULL, "generation" INTEGER NOT NULL, "deliveryId" TEXT,
  "leaseToken" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending', "commit" TEXT, "error" TEXT, "startedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "GithubResourceSyncJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GithubResourceSyncJob_registryId_fkey" FOREIGN KEY ("registryId") REFERENCES "GithubResourceRegistry"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GithubResourceSyncJob_registryId_deliveryId_key" ON "GithubResourceSyncJob"("registryId", "deliveryId");
CREATE INDEX "GithubResourceSyncJob_status_createdAt_idx" ON "GithubResourceSyncJob"("status", "createdAt");
CREATE TABLE "GithubRegistryResource" (
  "id" TEXT NOT NULL, "registryId" TEXT NOT NULL, "resourceId" TEXT NOT NULL, "kind" TEXT NOT NULL,
  "listingId" TEXT, "agentListingId" TEXT, "active" BOOLEAN NOT NULL DEFAULT true, CONSTRAINT "GithubRegistryResource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GithubRegistryResource_listing_kind_check" CHECK (("kind" = 'agent' AND "agentListingId" IS NOT NULL AND "listingId" IS NULL) OR ("kind" IN ('skill','mcp','pi-package','assistant') AND "listingId" IS NOT NULL AND "agentListingId" IS NULL)),
  CONSTRAINT "GithubRegistryResource_registryId_fkey" FOREIGN KEY ("registryId") REFERENCES "GithubResourceRegistry"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "GithubRegistryResource_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "GithubRegistryResource_agentListingId_fkey" FOREIGN KEY ("agentListingId") REFERENCES "AgentListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GithubRegistryResource_listingId_key" ON "GithubRegistryResource"("listingId");
CREATE UNIQUE INDEX "GithubRegistryResource_agentListingId_key" ON "GithubRegistryResource"("agentListingId");
CREATE UNIQUE INDEX "GithubRegistryResource_registryId_resourceId_key" ON "GithubRegistryResource"("registryId", "resourceId");
CREATE TABLE "GithubRegistryVersion" (
  "id" TEXT NOT NULL, "resourceId" TEXT NOT NULL, "version" TEXT NOT NULL, "digest" TEXT NOT NULL,
  "sourceRepository" TEXT NOT NULL, "sourceCommit" TEXT NOT NULL, "sourcePath" TEXT NOT NULL, "releaseId" TEXT, "agentReleaseId" TEXT,
  CONSTRAINT "GithubRegistryVersion_release_check" CHECK (("releaseId" IS NOT NULL)::int + ("agentReleaseId" IS NOT NULL)::int = 1),
  CONSTRAINT "GithubRegistryVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GithubRegistryVersion_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "GithubRegistryResource"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "GithubRegistryVersion_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "MarketRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "GithubRegistryVersion_agentReleaseId_fkey" FOREIGN KEY ("agentReleaseId") REFERENCES "AgentRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GithubRegistryVersion_releaseId_key" ON "GithubRegistryVersion"("releaseId");
CREATE UNIQUE INDEX "GithubRegistryVersion_agentReleaseId_key" ON "GithubRegistryVersion"("agentReleaseId");
CREATE UNIQUE INDEX "GithubRegistryVersion_resourceId_version_key" ON "GithubRegistryVersion"("resourceId", "version");
