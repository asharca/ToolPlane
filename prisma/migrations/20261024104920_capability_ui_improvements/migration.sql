-- AlterTable
ALTER TABLE "AgentServer" ADD COLUMN     "approvedToolSignatures" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "pendingToolChanges" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "ChatAssistantMcpGrant" ADD COLUMN     "approvedToolSignatures" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "pendingToolChanges" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "ChatToolConfirmation" ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ChatTurn" ADD COLUMN     "assistantRevisionId" TEXT;
