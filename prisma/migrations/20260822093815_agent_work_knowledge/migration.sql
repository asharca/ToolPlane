ALTER TABLE "AgentSandbox" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "AgentSandbox_agentId_isDefault_idx" ON "AgentSandbox"("agentId", "isDefault");
CREATE UNIQUE INDEX "AgentSandbox_one_default_per_agent" ON "AgentSandbox"("agentId") WHERE "isDefault";

CREATE TABLE "WorkSession" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "sandboxId" TEXT,
    "conversationId" TEXT NOT NULL,
    "title" TEXT,
    "task" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "result" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkSession_conversationId_key" ON "WorkSession"("conversationId");
CREATE INDEX "WorkSession_workspaceId_agentId_updatedAt_idx" ON "WorkSession"("workspaceId", "agentId", "updatedAt");
CREATE INDEX "WorkSession_sandboxId_idx" ON "WorkSession"("sandboxId");
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "Sandbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "KnowledgeBase" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "providerId" TEXT,
    "embeddingModel" TEXT NOT NULL,
    "dimensions" INTEGER,
    "chunkSize" INTEGER NOT NULL DEFAULT 1200,
    "chunkOverlap" INTEGER NOT NULL DEFAULT 200,
    "topK" INTEGER NOT NULL DEFAULT 6,
    "threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KnowledgeBase_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KnowledgeBase_workspaceId_name_key" ON "KnowledgeBase"("workspaceId", "name");
CREATE INDEX "KnowledgeBase_workspaceId_updatedAt_idx" ON "KnowledgeBase"("workspaceId", "updatedAt");
ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ModelProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "sandboxId" TEXT,
    "sourcePath" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KnowledgeDocument_knowledgeBaseId_updatedAt_idx" ON "KnowledgeDocument"("knowledgeBaseId", "updatedAt");
CREATE INDEX "KnowledgeDocument_sandboxId_idx" ON "KnowledgeDocument"("sandboxId");
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "Sandbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KnowledgeChunk_documentId_ordinal_key" ON "KnowledgeChunk"("documentId", "ordinal");
CREATE INDEX "KnowledgeChunk_documentId_idx" ON "KnowledgeChunk"("documentId");
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentKnowledgeBase" (
    "agentId" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    CONSTRAINT "AgentKnowledgeBase_pkey" PRIMARY KEY ("agentId", "knowledgeBaseId")
);
CREATE INDEX "AgentKnowledgeBase_knowledgeBaseId_idx" ON "AgentKnowledgeBase"("knowledgeBaseId");
ALTER TABLE "AgentKnowledgeBase" ADD CONSTRAINT "AgentKnowledgeBase_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentKnowledgeBase" ADD CONSTRAINT "AgentKnowledgeBase_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
