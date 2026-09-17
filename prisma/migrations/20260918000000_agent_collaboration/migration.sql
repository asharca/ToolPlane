-- CreateTable
CREATE TABLE "AgentCollaborationRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "rootId" TEXT NOT NULL,
    "parentTaskId" TEXT,
    "workSessionId" TEXT,
    "chain" TEXT[],
    "allowedAgentIds" TEXT[],
    "taskCount" INTEGER NOT NULL DEFAULT 0,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCollaborationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCollaborationTask" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "callerAgentId" TEXT NOT NULL,
    "targetAgentId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "rootId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "parentTaskId" TEXT,
    "ancestorTaskIds" TEXT[],
    "contextId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "targetBinding" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'submitted',
    "message" TEXT NOT NULL,
    "result" TEXT,
    "question" TEXT,
    "artifacts" JSONB NOT NULL DEFAULT '[]',
    "usage" JSONB,
    "errorCode" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvedById" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCollaborationTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCollaborationMessage" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCollaborationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentCollaborationRun_rootId_idx" ON "AgentCollaborationRun"("rootId");

-- CreateIndex
CREATE INDEX "AgentCollaborationRun_agentId_scopeKey_idx" ON "AgentCollaborationRun"("agentId", "scopeKey");

-- CreateIndex
CREATE INDEX "AgentCollaborationRun_deadlineAt_idx" ON "AgentCollaborationRun"("deadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCollaborationTask_contextId_key" ON "AgentCollaborationTask"("contextId");

-- CreateIndex
CREATE INDEX "AgentCollaborationTask_workspaceId_callerAgentId_createdAt_idx" ON "AgentCollaborationTask"("workspaceId", "callerAgentId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentCollaborationTask_state_createdAt_idx" ON "AgentCollaborationTask"("state", "createdAt");

-- CreateIndex
CREATE INDEX "AgentCollaborationTask_rootId_idx" ON "AgentCollaborationTask"("rootId");

-- CreateIndex
CREATE INDEX "AgentCollaborationTask_targetAgentId_state_idx" ON "AgentCollaborationTask"("targetAgentId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCollaborationTask_callerAgentId_scopeKey_requestId_key" ON "AgentCollaborationTask"("callerAgentId", "scopeKey", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCollaborationMessage_taskId_requestId_key" ON "AgentCollaborationMessage"("taskId", "requestId");

-- AddForeignKey
ALTER TABLE "AgentCollaborationRun" ADD CONSTRAINT "AgentCollaborationRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCollaborationRun" ADD CONSTRAINT "AgentCollaborationRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCollaborationTask" ADD CONSTRAINT "AgentCollaborationTask_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCollaborationTask" ADD CONSTRAINT "AgentCollaborationTask_callerAgentId_fkey" FOREIGN KEY ("callerAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCollaborationTask" ADD CONSTRAINT "AgentCollaborationTask_targetAgentId_fkey" FOREIGN KEY ("targetAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCollaborationTask" ADD CONSTRAINT "AgentCollaborationTask_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentCollaborationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCollaborationMessage" ADD CONSTRAINT "AgentCollaborationMessage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AgentCollaborationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
