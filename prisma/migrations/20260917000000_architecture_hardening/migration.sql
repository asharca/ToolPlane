CREATE TABLE "ToolkitInstallation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "toolkitId" TEXT NOT NULL REFERENCES "Toolkit"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "client" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastUsedAt" TIMESTAMP(3)
);
CREATE INDEX "ToolkitInstallation_userId_toolkitId_status_idx" ON "ToolkitInstallation"("userId", "toolkitId", "status");
ALTER TABLE "ApiToken" ADD COLUMN "installationId" TEXT;
ALTER TABLE "ApiToken" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "ToolkitInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ApiToken_installationId_idx" ON "ApiToken"("installationId");
CREATE TABLE "AgentUploadReservation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "agentId" TEXT NOT NULL REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "runtimeId" TEXT NOT NULL,
  "storagePath" TEXT NOT NULL,
  "reservedBytes" INTEGER NOT NULL CHECK ("reservedBytes" > 0),
  "status" TEXT NOT NULL DEFAULT 'uploading',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "AgentUploadReservation_workspaceId_status_idx" ON "AgentUploadReservation"("workspaceId", "status");
CREATE INDEX "AgentUploadReservation_status_expiresAt_idx" ON "AgentUploadReservation"("status", "expiresAt");
