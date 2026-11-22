-- AlterTable
ALTER TABLE "AgentTrigger" ADD COLUMN     "webhookAuth" TEXT NOT NULL DEFAULT 'bearer',
ADD COLUMN     "webhookIgnoredSenders" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "webhookSecret" JSONB;

-- CreateTable
CREATE TABLE "AgentTriggerEvent" (
    "id" TEXT NOT NULL,
    "triggerId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "threadKey" TEXT,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "conversationId" TEXT,
    "taskId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTriggerEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTriggerThread" (
    "id" TEXT NOT NULL,
    "triggerId" TEXT NOT NULL,
    "threadKey" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTriggerThread_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentTriggerEvent_triggerId_threadKey_status_createdAt_idx" ON "AgentTriggerEvent"("triggerId", "threadKey", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTriggerEvent_status_updatedAt_idx" ON "AgentTriggerEvent"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentTriggerEvent_triggerId_createdAt_idx" ON "AgentTriggerEvent"("triggerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTriggerEvent_triggerId_dedupeKey_key" ON "AgentTriggerEvent"("triggerId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTriggerThread_conversationId_key" ON "AgentTriggerThread"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTriggerThread_triggerId_threadKey_key" ON "AgentTriggerThread"("triggerId", "threadKey");

-- AddForeignKey
ALTER TABLE "AgentTriggerEvent" ADD CONSTRAINT "AgentTriggerEvent_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "AgentTrigger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTriggerThread" ADD CONSTRAINT "AgentTriggerThread_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "AgentTrigger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTriggerThread" ADD CONSTRAINT "AgentTriggerThread_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
