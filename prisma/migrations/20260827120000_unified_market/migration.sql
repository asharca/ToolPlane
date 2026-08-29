-- CreateTable
CREATE TABLE "MarketListing" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "publisherKind" TEXT NOT NULL DEFAULT 'workspace',
    "publisherWorkspaceId" TEXT,
    "publishedById" TEXT,
    "sourceServerId" TEXT,
    "sourceSkillId" TEXT,
    "sourceDeploymentId" TEXT,
    "sourceInstalledSkillId" TEXT,
    "sourceToolkitId" TEXT,
    "sourceAgentId" TEXT,
    "name" TEXT NOT NULL,
    "summary" TEXT,
    "iconUrl" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "curated" BOOLEAN NOT NULL DEFAULT false,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "latestVersion" INTEGER NOT NULL DEFAULT 0,
    "latestReleaseId" TEXT,
    "pendingReleaseId" TEXT,
    "installCount" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketRelease" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "manifestVersion" INTEGER NOT NULL DEFAULT 1,
    "manifest" JSONB NOT NULL,
    "releaseSummary" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "releaseNotes" TEXT,
    "scanResult" JSONB,
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketInstall" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "currentReleaseId" TEXT NOT NULL,
    "ignoredReleaseId" TEXT,
    "targetWorkspaceId" TEXT NOT NULL,
    "installedById" TEXT,
    "deploymentId" TEXT,
    "installedSkillId" TEXT,
    "toolkitId" TEXT,
    "agentId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'installing',
    "updatePolicy" TEXT NOT NULL DEFAULT 'manual',
    "requirements" JSONB,
    "resourceMap" JSONB,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketInstall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketListing_sourceServerId_key" ON "MarketListing"("sourceServerId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketListing_sourceSkillId_key" ON "MarketListing"("sourceSkillId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketListing_sourceDeploymentId_key" ON "MarketListing"("sourceDeploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketListing_sourceInstalledSkillId_key" ON "MarketListing"("sourceInstalledSkillId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketListing_sourceToolkitId_key" ON "MarketListing"("sourceToolkitId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketListing_sourceAgentId_key" ON "MarketListing"("sourceAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketListing_latestReleaseId_key" ON "MarketListing"("latestReleaseId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketListing_pendingReleaseId_key" ON "MarketListing"("pendingReleaseId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketListing_namespace_slug_key" ON "MarketListing"("namespace", "slug");

-- CreateIndex
CREATE INDEX "MarketListing_kind_status_isFeatured_installCount_published_idx" ON "MarketListing"("kind", "status", "isFeatured", "installCount", "publishedAt");

-- CreateIndex
CREATE INDEX "MarketListing_publisherWorkspaceId_status_updatedAt_idx" ON "MarketListing"("publisherWorkspaceId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "MarketListing_pendingReleaseId_updatedAt_idx" ON "MarketListing"("pendingReleaseId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketRelease_listingId_version_key" ON "MarketRelease"("listingId", "version");

-- CreateIndex
CREATE INDEX "MarketRelease_listingId_publishedAt_idx" ON "MarketRelease"("listingId", "publishedAt");

-- CreateIndex
CREATE INDEX "MarketRelease_reviewStatus_createdAt_idx" ON "MarketRelease"("reviewStatus", "createdAt");

-- CreateIndex
CREATE INDEX "MarketRelease_reviewedById_idx" ON "MarketRelease"("reviewedById");

-- CreateIndex
CREATE UNIQUE INDEX "MarketInstall_deploymentId_key" ON "MarketInstall"("deploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketInstall_installedSkillId_key" ON "MarketInstall"("installedSkillId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketInstall_toolkitId_key" ON "MarketInstall"("toolkitId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketInstall_agentId_key" ON "MarketInstall"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketInstall_targetWorkspaceId_listingId_key" ON "MarketInstall"("targetWorkspaceId", "listingId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketInstall_targetWorkspaceId_idempotencyKey_key" ON "MarketInstall"("targetWorkspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "MarketInstall_listingId_status_updatedAt_idx" ON "MarketInstall"("listingId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "MarketInstall_currentReleaseId_createdAt_idx" ON "MarketInstall"("currentReleaseId", "createdAt");

-- CreateIndex
CREATE INDEX "MarketInstall_targetWorkspaceId_status_updatedAt_idx" ON "MarketInstall"("targetWorkspaceId", "status", "updatedAt");

-- AddForeignKey
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_publisherWorkspaceId_fkey" FOREIGN KEY ("publisherWorkspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_sourceServerId_fkey" FOREIGN KEY ("sourceServerId") REFERENCES "Server"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_sourceSkillId_fkey" FOREIGN KEY ("sourceSkillId") REFERENCES "Skill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_sourceDeploymentId_fkey" FOREIGN KEY ("sourceDeploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_sourceInstalledSkillId_fkey" FOREIGN KEY ("sourceInstalledSkillId") REFERENCES "InstalledSkill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_sourceToolkitId_fkey" FOREIGN KEY ("sourceToolkitId") REFERENCES "Toolkit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_sourceAgentId_fkey" FOREIGN KEY ("sourceAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_latestReleaseId_fkey" FOREIGN KEY ("latestReleaseId") REFERENCES "MarketRelease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_pendingReleaseId_fkey" FOREIGN KEY ("pendingReleaseId") REFERENCES "MarketRelease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketRelease" ADD CONSTRAINT "MarketRelease_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketRelease" ADD CONSTRAINT "MarketRelease_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketInstall" ADD CONSTRAINT "MarketInstall_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketInstall" ADD CONSTRAINT "MarketInstall_currentReleaseId_fkey" FOREIGN KEY ("currentReleaseId") REFERENCES "MarketRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketInstall" ADD CONSTRAINT "MarketInstall_ignoredReleaseId_fkey" FOREIGN KEY ("ignoredReleaseId") REFERENCES "MarketRelease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketInstall" ADD CONSTRAINT "MarketInstall_targetWorkspaceId_fkey" FOREIGN KEY ("targetWorkspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketInstall" ADD CONSTRAINT "MarketInstall_installedById_fkey" FOREIGN KEY ("installedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketInstall" ADD CONSTRAINT "MarketInstall_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketInstall" ADD CONSTRAINT "MarketInstall_installedSkillId_fkey" FOREIGN KEY ("installedSkillId") REFERENCES "InstalledSkill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketInstall" ADD CONSTRAINT "MarketInstall_toolkitId_fkey" FOREIGN KEY ("toolkitId") REFERENCES "Toolkit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketInstall" ADD CONSTRAINT "MarketInstall_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
