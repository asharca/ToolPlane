ALTER TABLE "AgentTrigger"
  ADD COLUMN "sourceConfig" JSONB,
  ADD COLUMN "sourceCredential" JSONB,
  ADD COLUMN "lastSyncAt" TIMESTAMP(3),
  ADD COLUMN "lastSyncStatus" TEXT,
  ADD COLUMN "lastSyncError" TEXT,
  ADD COLUMN "syncRetryAt" TIMESTAMP(3),
  ADD COLUMN "syncCursor" TEXT,
  ADD COLUMN "syncFailures" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "AgentTriggerItem" (
  "id" TEXT PRIMARY KEY,
  "triggerId" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "revision" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentTriggerItem_triggerId_fkey" FOREIGN KEY ("triggerId")
    REFERENCES "AgentTrigger"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AgentTriggerItem_triggerId_externalId_revision_key"
  ON "AgentTriggerItem"("triggerId", "externalId", "revision");
