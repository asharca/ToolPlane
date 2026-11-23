-- CreateTable
CREATE TABLE "OfficialPluginEnvPreset" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "configuredKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "encryptedValues" JSONB NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficialPluginEnvPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketInstallEnvConfig" (
    "installId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "configuredKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "encryptedValues" JSONB,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketInstallEnvConfig_pkey" PRIMARY KEY ("installId")
);

-- CreateIndex
CREATE UNIQUE INDEX "OfficialPluginEnvPreset_listingId_key" ON "OfficialPluginEnvPreset"("listingId");

-- CreateIndex
CREATE INDEX "MarketInstallEnvConfig_workspaceId_idx" ON "MarketInstallEnvConfig"("workspaceId");

-- AddForeignKey
ALTER TABLE "OfficialPluginEnvPreset" ADD CONSTRAINT "OfficialPluginEnvPreset_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficialPluginEnvPreset" ADD CONSTRAINT "OfficialPluginEnvPreset_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketInstallEnvConfig" ADD CONSTRAINT "MarketInstallEnvConfig_installId_fkey" FOREIGN KEY ("installId") REFERENCES "MarketInstall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketInstallEnvConfig" ADD CONSTRAINT "MarketInstallEnvConfig_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
