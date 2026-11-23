-- Polling subscriptions and their account connections are removed; only schedule and webhook triggers remain.
DELETE FROM "AgentTrigger" WHERE "kind" NOT IN ('schedule', 'webhook');

-- DropForeignKey
ALTER TABLE "AccountConnection" DROP CONSTRAINT "AccountConnection_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "AccountConnectionOAuthPending" DROP CONSTRAINT "AccountConnectionOAuthPending_connectionId_fkey";

-- DropForeignKey
ALTER TABLE "AgentTrigger" DROP CONSTRAINT "AgentTrigger_connectionId_fkey";

-- DropForeignKey
ALTER TABLE "AgentTriggerItem" DROP CONSTRAINT "AgentTriggerItem_triggerId_fkey";

-- DropIndex
DROP INDEX "AgentTrigger_connectionId_idx";

-- AlterTable
ALTER TABLE "AgentTrigger" DROP COLUMN "connectionId",
DROP COLUMN "lastSyncAt",
DROP COLUMN "lastSyncError",
DROP COLUMN "lastSyncStatus",
DROP COLUMN "sourceConfig",
DROP COLUMN "syncCursor",
DROP COLUMN "syncFailures",
DROP COLUMN "syncRetryAt";

-- DropTable
DROP TABLE "AccountConnection";

-- DropTable
DROP TABLE "AccountConnectionOAuthPending";

-- DropTable
DROP TABLE "AgentTriggerItem";

