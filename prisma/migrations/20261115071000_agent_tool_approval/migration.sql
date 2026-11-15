ALTER TABLE "Agent" ADD COLUMN "toolApproval" JSONB;
CREATE TABLE "AgentToolApproval" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "conversationId" TEXT,
  "lease" TEXT NOT NULL,
  "toolCallId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "argumentHash" TEXT NOT NULL,
  "argumentSummary" TEXT NOT NULL,
  "entryKind" TEXT NOT NULL,
  "channelId" TEXT,
  "channelSource" JSONB,
  "shortCode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "decidedAt" TIMESTAMP(3),
  "decidedBy" TEXT,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentToolApproval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentToolApproval_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "A2ATask"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AgentToolApproval_shortCode_key" ON "AgentToolApproval"("shortCode");
CREATE UNIQUE INDEX "AgentToolApproval_taskId_lease_toolCallId_key" ON "AgentToolApproval"("taskId", "lease", "toolCallId");
CREATE INDEX "AgentToolApproval_taskId_lease_status_expiresAt_idx" ON "AgentToolApproval"("taskId", "lease", "status", "expiresAt");
CREATE INDEX "AgentToolApproval_conversationId_status_idx" ON "AgentToolApproval"("conversationId", "status");
