-- AlterTable
ALTER TABLE "LogEvent" ADD COLUMN "taskId" TEXT;

-- CreateIndex
CREATE INDEX "LogEvent_taskId_createdAt_idx" ON "LogEvent"("taskId", "createdAt");
