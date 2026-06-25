-- AlterTable
ALTER TABLE "InstalledSkill" ADD COLUMN     "agentInvocable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "content" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "effort" TEXT NOT NULL DEFAULT 'default',
ADD COLUMN     "files" JSONB,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "source" TEXT,
ADD COLUMN     "sourceRef" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'published',
ADD COLUMN     "userInvocable" BOOLEAN NOT NULL DEFAULT true,
ALTER COLUMN "skillId" DROP NOT NULL;
