ALTER TYPE "NotificationKind" ADD VALUE 'agent_budget_alert';
ALTER TABLE "Agent" ADD COLUMN "monthlyBudgetMicros" BIGINT, ADD COLUMN "budgetAlertedMonth" TEXT;
ALTER TABLE "A2AEntryBinding" DROP CONSTRAINT "A2AEntryBinding_kind_check",
  ADD CONSTRAINT "A2AEntryBinding_kind_check" CHECK ("kind" IN ('chat','work','channel','control','trigger'));
CREATE TABLE "AgentUsage" (
 "id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL, "agentId" TEXT NOT NULL, "conversationId" TEXT,
 "taskId" TEXT NOT NULL UNIQUE, "entryKind" TEXT NOT NULL, "model" TEXT, "providerId" TEXT,
 "inputTokens" INTEGER NOT NULL, "outputTokens" INTEGER NOT NULL, "cacheReadTokens" INTEGER NOT NULL,
 "cacheWriteTokens" INTEGER NOT NULL, "costMicros" BIGINT NOT NULL, "succeeded" BOOLEAN NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 FOREIGN KEY ("agentId", "workspaceId") REFERENCES "Agent"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE,
 FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "AgentUsage_agentId_createdAt_idx" ON "AgentUsage"("agentId", "createdAt");
CREATE INDEX "AgentUsage_workspaceId_createdAt_idx" ON "AgentUsage"("workspaceId", "createdAt");
CREATE TABLE "AgentTrigger" (
 "id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL, "agentId" TEXT NOT NULL, "kind" TEXT NOT NULL,
 "name" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true, "cron" TEXT, "timezone" TEXT,
 "prompt" TEXT NOT NULL, "secretHash" TEXT, "actorId" TEXT NOT NULL, "nextRunAt" TIMESTAMP(3),
 "lastRunAt" TIMESTAMP(3), "lastStatus" TEXT, "lastError" TEXT, "lastConversationId" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 FOREIGN KEY ("agentId", "workspaceId") REFERENCES "Agent"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE,
 FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AgentTrigger_agentId_createdAt_idx" ON "AgentTrigger"("agentId", "createdAt");
CREATE INDEX "AgentTrigger_enabled_nextRunAt_idx" ON "AgentTrigger"("enabled", "nextRunAt");
