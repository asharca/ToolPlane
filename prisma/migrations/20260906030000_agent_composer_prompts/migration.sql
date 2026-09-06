CREATE TABLE "AgentComposerPrompt" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentComposerPrompt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentComposerPrompt_agentId_updatedAt_idx" ON "AgentComposerPrompt"("agentId", "updatedAt");
ALTER TABLE "AgentComposerPrompt" ADD CONSTRAINT "AgentComposerPrompt_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
