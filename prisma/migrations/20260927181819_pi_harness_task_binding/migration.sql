-- DropForeignKey
ALTER TABLE "A2AToolApproval" DROP CONSTRAINT "A2AToolApproval_taskId_fkey";

-- DropIndex
DROP INDEX "Skill_sourceRegistry_sourcePath_idx";

-- AlterTable
ALTER TABLE "A2ATask" ADD COLUMN     "executionBackend" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN     "nativeOperationId" TEXT;

-- AddForeignKey
ALTER TABLE "A2AToolApproval" ADD CONSTRAINT "A2AToolApproval_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "A2ATask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
