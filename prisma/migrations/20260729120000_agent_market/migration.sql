-- CreateTable
CREATE TABLE "AgentListing" (
    "id" TEXT NOT NULL,
    "publisherWorkspaceId" TEXT NOT NULL,
    "sourceAgentId" TEXT,
    "publishedById" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT,
    "iconUrl" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'draft',
    "latestVersion" INTEGER NOT NULL DEFAULT 0,
    "latestReleaseId" TEXT,
    "installCount" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRelease" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "manifestVersion" INTEGER NOT NULL DEFAULT 1,
    "manifest" JSONB NOT NULL,
    "releaseSummary" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentInstall" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "targetWorkspaceId" TEXT NOT NULL,
    "installedById" TEXT NOT NULL,
    "agentId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'needs_setup',
    "requirements" JSONB NOT NULL,
    "resourceMap" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentInstall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentListing_sourceAgentId_key" ON "AgentListing"("sourceAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentListing_latestReleaseId_key" ON "AgentListing"("latestReleaseId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentListing_publisherWorkspaceId_slug_key" ON "AgentListing"("publisherWorkspaceId", "slug");

-- CreateIndex
CREATE INDEX "AgentListing_status_installCount_publishedAt_idx" ON "AgentListing"("status", "installCount", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRelease_listingId_version_key" ON "AgentRelease"("listingId", "version");

-- CreateIndex
CREATE INDEX "AgentRelease_listingId_publishedAt_idx" ON "AgentRelease"("listingId", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentInstall_agentId_key" ON "AgentInstall"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentInstall_targetWorkspaceId_idempotencyKey_key" ON "AgentInstall"("targetWorkspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentInstall_releaseId_createdAt_idx" ON "AgentInstall"("releaseId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentInstall_targetWorkspaceId_createdAt_idx" ON "AgentInstall"("targetWorkspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentListing" ADD CONSTRAINT "AgentListing_publisherWorkspaceId_fkey" FOREIGN KEY ("publisherWorkspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentListing" ADD CONSTRAINT "AgentListing_sourceAgentId_fkey" FOREIGN KEY ("sourceAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentListing" ADD CONSTRAINT "AgentListing_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentListing" ADD CONSTRAINT "AgentListing_latestReleaseId_fkey" FOREIGN KEY ("latestReleaseId") REFERENCES "AgentRelease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRelease" ADD CONSTRAINT "AgentRelease_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "AgentListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentInstall" ADD CONSTRAINT "AgentInstall_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "AgentRelease"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentInstall" ADD CONSTRAINT "AgentInstall_targetWorkspaceId_fkey" FOREIGN KEY ("targetWorkspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentInstall" ADD CONSTRAINT "AgentInstall_installedById_fkey" FOREIGN KEY ("installedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentInstall" ADD CONSTRAINT "AgentInstall_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
