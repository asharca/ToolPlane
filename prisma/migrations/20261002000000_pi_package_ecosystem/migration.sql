ALTER TABLE "MarketListing" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'public';
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_visibility_check" CHECK ("visibility" IN ('public', 'private'));

CREATE TABLE "PiPackageSource" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('catalog', 'npm', 'git')),
  "url" TEXT NOT NULL,
  "credentialsEnc" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "PiPackageSource_workspaceId_kind_idx" ON "PiPackageSource"("workspaceId", "kind");

CREATE TABLE "PiPackageTracking" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "listingId" TEXT NOT NULL REFERENCES "MarketListing"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sourceId" TEXT REFERENCES "PiPackageSource"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "requested" TEXT NOT NULL,
  "checkedAt" TIMESTAMP(3),
  "latestIdentity" TEXT,
  "latestVersion" TEXT,
  "errorCode" TEXT,
  "ignoredIdentity" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "PiPackageTracking_listingId_key" ON "PiPackageTracking"("listingId");
CREATE INDEX "PiPackageTracking_workspaceId_checkedAt_idx" ON "PiPackageTracking"("workspaceId", "checkedAt");
CREATE INDEX "PiPackageTracking_sourceId_idx" ON "PiPackageTracking"("sourceId");

CREATE TABLE "PiPackageClientInstallation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "marketInstallId" TEXT NOT NULL REFERENCES "MarketInstall"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "releaseId" TEXT NOT NULL REFERENCES "MarketRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "client" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'revoked')),
  "tokenHash" TEXT NOT NULL,
  "bindings" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastUsedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "PiPackageClientInstallation_tokenHash_key" ON "PiPackageClientInstallation"("tokenHash");
CREATE INDEX "PiPackageClientInstallation_workspaceId_userId_status_idx" ON "PiPackageClientInstallation"("workspaceId", "userId", "status");
CREATE INDEX "PiPackageClientInstallation_marketInstallId_status_idx" ON "PiPackageClientInstallation"("marketInstallId", "status");
CREATE INDEX "PiPackageClientInstallation_releaseId_idx" ON "PiPackageClientInstallation"("releaseId");
