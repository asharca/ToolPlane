CREATE TABLE "ChatAssistant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "systemPrompt" TEXT,
    "modelProviderId" TEXT,
    "model" TEXT,
    "maxSteps" INTEGER NOT NULL DEFAULT 8,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatAssistant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatAssistantMcpGrant" (
    "assistantId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatAssistantMcpGrant_pkey" PRIMARY KEY ("assistantId", "deploymentId")
);

CREATE TABLE "ChatThread" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "assistantId" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatThread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatTurn" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ChatTurn_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "parts" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChatAssistant_workspaceId_updatedAt_idx" ON "ChatAssistant"("workspaceId", "updatedAt");
CREATE INDEX "ChatAssistant_modelProviderId_idx" ON "ChatAssistant"("modelProviderId");
CREATE INDEX "ChatAssistantMcpGrant_deploymentId_idx" ON "ChatAssistantMcpGrant"("deploymentId");
CREATE INDEX "ChatThread_workspaceId_updatedAt_idx" ON "ChatThread"("workspaceId", "updatedAt");
CREATE INDEX "ChatThread_assistantId_updatedAt_idx" ON "ChatThread"("assistantId", "updatedAt");
CREATE INDEX "ChatTurn_threadId_createdAt_idx" ON "ChatTurn"("threadId", "createdAt");
CREATE INDEX "ChatMessage_threadId_createdAt_idx" ON "ChatMessage"("threadId", "createdAt");
CREATE INDEX "ChatMessage_turnId_createdAt_idx" ON "ChatMessage"("turnId", "createdAt");

ALTER TABLE "ChatAssistant" ADD CONSTRAINT "ChatAssistant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatAssistant" ADD CONSTRAINT "ChatAssistant_modelProviderId_fkey" FOREIGN KEY ("modelProviderId") REFERENCES "ModelProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChatAssistantMcpGrant" ADD CONSTRAINT "ChatAssistantMcpGrant_assistantId_fkey" FOREIGN KEY ("assistantId") REFERENCES "ChatAssistant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatAssistantMcpGrant" ADD CONSTRAINT "ChatAssistantMcpGrant_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_assistantId_fkey" FOREIGN KEY ("assistantId") REFERENCES "ChatAssistant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatTurn" ADD CONSTRAINT "ChatTurn_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "ChatTurn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
