CREATE TABLE "A2ATaskFile" (
  "id" TEXT NOT NULL,
  "taskId" TEXT,
  "workspaceId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "source" JSONB,
  "errorCode" TEXT,
  "storagePath" TEXT,
  "size" INTEGER,
  "sha256" TEXT,
  "uploadToken" TEXT,
  "uploadStartedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "A2ATaskFile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "A2ATaskFile_status_check" CHECK ("status" IN ('pending', 'uploading', 'ready', 'failed')),
  CONSTRAINT "A2ATaskFile_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "A2ATask"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "A2ATaskFile_size_check" CHECK ("size" IS NULL OR ("size" >= 0 AND "size" <= 10485760)),
  CONSTRAINT "A2ATaskFile_ready_check" CHECK ("status" <> 'ready' OR ("storagePath" IS NOT NULL AND "size" IS NOT NULL AND "sha256" IS NOT NULL AND "sha256" ~ '^[0-9a-f]{64}$'))
);
CREATE UNIQUE INDEX "A2ATaskFile_taskId_sourceKey_key" ON "A2ATaskFile"("taskId", "sourceKey");
CREATE INDEX "A2ATaskFile_expiresAt_idx" ON "A2ATaskFile"("expiresAt");
CREATE INDEX "A2ATaskFile_workspaceId_idx" ON "A2ATaskFile"("workspaceId");
CREATE INDEX "A2ATaskFile_status_uploadStartedAt_idx" ON "A2ATaskFile"("status", "uploadStartedAt");
ALTER TABLE "A2ATask" ADD COLUMN "remoteFilesStatus" TEXT NOT NULL DEFAULT 'ready', ADD COLUMN "remoteObservedState" INTEGER;
