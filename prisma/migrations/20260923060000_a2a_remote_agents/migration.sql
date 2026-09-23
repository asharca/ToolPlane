-- AlterTable
ALTER TABLE "A2AContext" ADD COLUMN     "remoteAgentId" TEXT;

-- AlterTable
ALTER TABLE "A2ATask" ADD COLUMN     "remoteCancelSentAt" TIMESTAMP(3),
ADD COLUMN     "remoteContextId" TEXT,
ADD COLUMN     "remoteDispatchedAt" TIMESTAMP(3),
ADD COLUMN     "remoteMessageId" TEXT,
ADD COLUMN     "remotePollAt" TIMESTAMP(3),
ADD COLUMN     "remotePollFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "remoteTaskId" TEXT;

-- CreateTable
CREATE TABLE "RemoteA2AAgent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cardUrl" TEXT NOT NULL,
    "rpcUrl" TEXT NOT NULL,
    "card" JSONB NOT NULL,
    "credential" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "allowedAgentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemoteA2AAgent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RemoteA2AAgent_workspaceId_enabled_idx" ON "RemoteA2AAgent"("workspaceId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "RemoteA2AAgent_id_workspaceId_key" ON "RemoteA2AAgent"("id", "workspaceId");

-- CreateIndex
CREATE INDEX "A2ATask_phase_remotePollAt_idx" ON "A2ATask"("phase", "remotePollAt");

-- AddForeignKey
ALTER TABLE "A2AContext" ADD CONSTRAINT "A2AContext_remoteAgentId_workspaceId_fkey" FOREIGN KEY ("remoteAgentId", "workspaceId") REFERENCES "RemoteA2AAgent"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemoteA2AAgent" ADD CONSTRAINT "RemoteA2AAgent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve existing identities and make remote targets structurally distinct.
ALTER TABLE "A2AContext" DROP CONSTRAINT "A2AContext_target_shape";
ALTER TABLE "A2AContext" ADD CONSTRAINT "A2AContext_target_shape" CHECK (
  ("targetKind"='published' AND "endpointId" IS NOT NULL AND "clientId" IS NOT NULL AND "revisionId" IS NOT NULL AND "agentId" IS NULL AND "targetBinding" IS NULL AND "remoteAgentId" IS NULL)
  OR ("targetKind"='local' AND "agentId" IS NOT NULL AND "targetBinding" IS NOT NULL AND "endpointId" IS NULL AND "clientId" IS NULL AND "revisionId" IS NULL AND "runtimeAllocationId" IS NULL AND "remoteAgentId" IS NULL)
  OR ("targetKind"='remote' AND "remoteAgentId" IS NOT NULL AND "targetBinding" IS NOT NULL AND "agentId" IS NULL AND "endpointId" IS NULL AND "clientId" IS NULL AND "revisionId" IS NULL AND "runtimeAllocationId" IS NULL)
);
ALTER TABLE "RemoteA2AAgent" ADD CONSTRAINT "RemoteA2AAgent_revision_positive" CHECK (revision > 0);
ALTER TABLE "A2ATask" ADD CONSTRAINT "A2ATask_remote_poll_nonnegative" CHECK ("remotePollFailures" >= 0);
