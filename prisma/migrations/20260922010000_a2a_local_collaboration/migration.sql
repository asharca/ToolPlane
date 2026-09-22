-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "a2aInternalEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "A2AContext" ADD COLUMN     "agentId" TEXT,
ADD COLUMN     "targetBinding" TEXT,
ADD COLUMN     "targetKind" TEXT NOT NULL DEFAULT 'published',
ADD COLUMN     "workspaceId" TEXT,
ALTER COLUMN "endpointId" DROP NOT NULL,
ALTER COLUMN "revisionId" DROP NOT NULL,
ALTER COLUMN "clientId" DROP NOT NULL;

-- Existing published contexts retain their original ownership and revision.
UPDATE "A2AContext" c SET "workspaceId" = e."workspaceId" FROM "AgentEndpoint" e WHERE e.id=c."endpointId";
ALTER TABLE "A2AContext" ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "A2ATask" ADD COLUMN     "depth" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "parentTaskId" TEXT,
ADD COLUMN     "pendingQuestion" TEXT,
ADD COLUMN     "phase" TEXT NOT NULL DEFAULT 'queued',
ADD COLUMN     "resumeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rootTaskId" TEXT,
ADD COLUMN     "waitForTaskIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "A2AContext_workspaceId_agentId_idx" ON "A2AContext"("workspaceId", "agentId");

-- CreateIndex
CREATE INDEX "A2ATask_rootTaskId_parentTaskId_idx" ON "A2ATask"("rootTaskId", "parentTaskId");

-- CreateIndex
CREATE INDEX "A2ATask_state_phase_idx" ON "A2ATask"("state", "phase");

-- AddForeignKey
ALTER TABLE "A2AContext" ADD CONSTRAINT "A2AContext_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "A2AContext" ADD CONSTRAINT "A2AContext_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;


UPDATE "A2ATask" SET phase = CASE WHEN state=2 THEN 'executing' WHEN state IN (3,4,5,7) THEN 'done' WHEN state IN (6,8) THEN 'paused' ELSE 'queued' END;
ALTER TABLE "A2AContext" ADD CONSTRAINT "A2AContext_target_shape" CHECK (
  ("targetKind"='published' AND "endpointId" IS NOT NULL AND "revisionId" IS NOT NULL AND "clientId" IS NOT NULL AND "agentId" IS NULL AND "targetBinding" IS NULL)
  OR ("targetKind"='local' AND "endpointId" IS NULL AND "revisionId" IS NULL AND "clientId" IS NULL AND "agentId" IS NOT NULL AND "targetBinding" IS NOT NULL AND "runtimeAllocationId" IS NULL)
);
ALTER TABLE "A2ATask" ADD CONSTRAINT "A2ATask_local_limits" CHECK (depth BETWEEN 0 AND 3 AND "resumeCount" BETWEEN 0 AND 16 AND "parentTaskId" IS DISTINCT FROM id);
