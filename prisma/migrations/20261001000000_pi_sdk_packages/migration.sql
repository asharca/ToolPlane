-- Add pi-sdk to the runtimeKind check constraint
ALTER TABLE "Agent" DROP CONSTRAINT "Agent_runtimeKind_check";
ALTER TABLE "Agent"
ADD CONSTRAINT "Agent_runtimeKind_check"
CHECK ("runtimeKind" IN ('pi', 'pi-sdk', 'claude-code', 'dsh', 'hermes', 'hermes-rpc'));

-- CreateTable
CREATE TABLE "AgentPiPackage" (
    "agentId" TEXT NOT NULL,
    "marketInstallId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentPiPackage_pkey" PRIMARY KEY ("agentId","marketInstallId")
);

-- CreateIndex
CREATE INDEX "AgentPiPackage_marketInstallId_idx" ON "AgentPiPackage"("marketInstallId");

-- CreateIndex
CREATE INDEX "AgentPiPackage_releaseId_idx" ON "AgentPiPackage"("releaseId");

-- AddForeignKey
ALTER TABLE "AgentPiPackage" ADD CONSTRAINT "AgentPiPackage_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPiPackage" ADD CONSTRAINT "AgentPiPackage_marketInstallId_fkey" FOREIGN KEY ("marketInstallId") REFERENCES "MarketInstall"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPiPackage" ADD CONSTRAINT "AgentPiPackage_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "MarketRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
