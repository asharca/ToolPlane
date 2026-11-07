-- DropForeignKey
ALTER TABLE "SkillInvocation" DROP CONSTRAINT "SkillInvocation_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "SkillInvocation" DROP CONSTRAINT "SkillInvocation_toolkitId_fkey";

-- DropForeignKey
ALTER TABLE "SyncEvent" DROP CONSTRAINT "SyncEvent_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "SyncEvent" DROP CONSTRAINT "SyncEvent_toolkitId_fkey";

-- DropTable
DROP TABLE "SkillInvocation";

-- DropTable
DROP TABLE "SyncEvent";
