-- CreateTable
CREATE TABLE "AgentRuntime" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'hermes',
    "image" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'provisioning',
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "configHash" TEXT,
    "capabilities" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "lastStartedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRuntime_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentRuntime_agentId_key" ON "AgentRuntime"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRuntime_sandboxId_key" ON "AgentRuntime"("sandboxId");

-- CreateIndex
CREATE INDEX "AgentRuntime_workspaceId_kind_status_idx" ON "AgentRuntime"("workspaceId", "kind", "status");

-- AddForeignKey
ALTER TABLE "AgentRuntime" ADD CONSTRAINT "AgentRuntime_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRuntime" ADD CONSTRAINT "AgentRuntime_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRuntime" ADD CONSTRAINT "AgentRuntime_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "Sandbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "AgentAttachment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "conversationId" TEXT,
    "runtimeId" TEXT,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storage" TEXT NOT NULL DEFAULT 'hermes-volume',
    "storagePath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentAttachment_workspaceId_agentId_createdAt_idx" ON "AgentAttachment"("workspaceId", "agentId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentAttachment_conversationId_idx" ON "AgentAttachment"("conversationId");

-- AddForeignKey
ALTER TABLE "AgentAttachment" ADD CONSTRAINT "AgentAttachment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAttachment" ADD CONSTRAINT "AgentAttachment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAttachment" ADD CONSTRAINT "AgentAttachment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAttachment" ADD CONSTRAINT "AgentAttachment_runtimeId_fkey" FOREIGN KEY ("runtimeId") REFERENCES "AgentRuntime"("id") ON DELETE SET NULL ON UPDATE CASCADE;
