-- CreateTable
CREATE TABLE "AgentChannelConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'stopped',
    "config" JSONB,
    "credentials" JSONB,
    "inboundTokenHash" TEXT NOT NULL,
    "inboundTokenSecret" JSONB NOT NULL,
    "inboundTokenPrefix" TEXT NOT NULL,
    "runnerPid" INTEGER,
    "lastError" TEXT,
    "lastStartedAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentChannelConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentChannelConnection_inboundTokenHash_key" ON "AgentChannelConnection"("inboundTokenHash");

-- CreateIndex
CREATE INDEX "AgentChannelConnection_workspaceId_agentId_idx" ON "AgentChannelConnection"("workspaceId", "agentId");

-- CreateIndex
CREATE INDEX "AgentChannelConnection_platform_status_idx" ON "AgentChannelConnection"("platform", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentChannelConnection_agentId_platform_name_key" ON "AgentChannelConnection"("agentId", "platform", "name");

-- AddForeignKey
ALTER TABLE "AgentChannelConnection" ADD CONSTRAINT "AgentChannelConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentChannelConnection" ADD CONSTRAINT "AgentChannelConnection_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
