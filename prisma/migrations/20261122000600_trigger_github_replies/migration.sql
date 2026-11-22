-- AlterTable
ALTER TABLE "AgentTrigger" ADD COLUMN     "webhookReplyToken" JSONB;

-- AlterTable
ALTER TABLE "AgentTriggerEvent" ADD COLUMN     "replyAt" TIMESTAMP(3),
ADD COLUMN     "replyError" TEXT,
ADD COLUMN     "replyStatus" TEXT,
ADD COLUMN     "replyText" TEXT;

-- CreateIndex
CREATE INDEX "AgentTriggerEvent_replyStatus_replyAt_idx" ON "AgentTriggerEvent"("replyStatus", "replyAt");

