-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "activeRevisionId" TEXT,
ADD COLUMN     "runtimeSandboxId" TEXT,
ADD COLUMN     "runtimeTarget" TEXT NOT NULL DEFAULT 'managed',
ADD COLUMN     "samplingEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "McpConfigRevision" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "document" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "resolved" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpConfigRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "McpConfigRevision_deploymentId_createdAt_idx" ON "McpConfigRevision"("deploymentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpConfigRevision_deploymentId_revision_key" ON "McpConfigRevision"("deploymentId", "revision");

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_runtimeSandboxId_fkey" FOREIGN KEY ("runtimeSandboxId") REFERENCES "Sandbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpConfigRevision" ADD CONSTRAINT "McpConfigRevision_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
