-- AlterTable
ALTER TABLE "AgentEndpoint" ADD COLUMN     "a2aEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "A2AContext" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "ownerKey" TEXT NOT NULL,
    "runtimeAllocationId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "A2AContext_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "A2ATask" (
    "id" TEXT NOT NULL,
    "contextId" TEXT NOT NULL,
    "state" INTEGER NOT NULL,
    "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshot" JSONB NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "request" JSONB NOT NULL,
    "grant" JSONB NOT NULL,
    "leaseToken" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "A2ATask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "A2ARequest" (
    "id" TEXT NOT NULL,
    "ownerKey" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,

    CONSTRAINT "A2ARequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "A2AEvent" (
    "taskId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "A2AEvent_pkey" PRIMARY KEY ("taskId","sequence")
);

-- CreateIndex
CREATE INDEX "A2AContext_ownerKey_id_idx" ON "A2AContext"("ownerKey", "id");

-- CreateIndex
CREATE INDEX "A2AContext_endpointId_clientId_idx" ON "A2AContext"("endpointId", "clientId");

-- CreateIndex
CREATE INDEX "A2AContext_runtimeAllocationId_idx" ON "A2AContext"("runtimeAllocationId");

-- CreateIndex
CREATE INDEX "A2AContext_expiresAt_idx" ON "A2AContext"("expiresAt");

-- CreateIndex
CREATE INDEX "A2ATask_contextId_state_idx" ON "A2ATask"("contextId", "state");

-- CreateIndex
CREATE INDEX "A2ATask_statusAt_id_idx" ON "A2ATask"("statusAt", "id");

-- CreateIndex
CREATE INDEX "A2ATask_state_createdAt_idx" ON "A2ATask"("state", "createdAt");

-- CreateIndex
CREATE INDEX "A2ATask_deadlineAt_idx" ON "A2ATask"("deadlineAt");

-- CreateIndex
CREATE INDEX "A2ARequest_taskId_idx" ON "A2ARequest"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "A2ARequest_ownerKey_messageId_key" ON "A2ARequest"("ownerKey", "messageId");

-- AddForeignKey
ALTER TABLE "A2AContext" ADD CONSTRAINT "A2AContext_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "AgentEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "A2AContext" ADD CONSTRAINT "A2AContext_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "AgentEndpointRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "A2AContext" ADD CONSTRAINT "A2AContext_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "AgentApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "A2AContext" ADD CONSTRAINT "A2AContext_runtimeAllocationId_fkey" FOREIGN KEY ("runtimeAllocationId") REFERENCES "AgentEndpointRuntime"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "A2ATask" ADD CONSTRAINT "A2ATask_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "A2AContext"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "A2ARequest" ADD CONSTRAINT "A2ARequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "A2ATask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "A2AEvent" ADD CONSTRAINT "A2AEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "A2ATask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
