-- CreateTable
CREATE TABLE "Sandbox" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'docker',
    "image" TEXT,
    "hostRoot" TEXT,
    "network" TEXT NOT NULL DEFAULT 'isolated',
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sandbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSandbox" (
    "agentId" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,

    CONSTRAINT "AgentSandbox_pkey" PRIMARY KEY ("agentId","sandboxId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Sandbox_deploymentId_key" ON "Sandbox"("deploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Sandbox_workspaceId_slug_key" ON "Sandbox"("workspaceId", "slug");

-- AddForeignKey
ALTER TABLE "Sandbox" ADD CONSTRAINT "Sandbox_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sandbox" ADD CONSTRAINT "Sandbox_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSandbox" ADD CONSTRAINT "AgentSandbox_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSandbox" ADD CONSTRAINT "AgentSandbox_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "Sandbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
