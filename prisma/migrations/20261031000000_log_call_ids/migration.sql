-- AlterTable
ALTER TABLE "LogEvent" ADD COLUMN     "callId" TEXT;

-- CreateIndex
CREATE INDEX "LogEvent_callId_idx" ON "LogEvent"("callId");

-- CreateIndex
CREATE INDEX "LogEvent_workspaceId_domain_eventName_createdAt_idx" ON "LogEvent"("workspaceId", "domain", "eventName", "createdAt");
