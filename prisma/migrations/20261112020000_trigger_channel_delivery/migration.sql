ALTER TABLE "Conversation" ADD COLUMN "triggerId" TEXT;
ALTER TABLE "AgentTrigger"
  ADD COLUMN "deliveryConnectionId" TEXT,
  ADD COLUMN "deliveryChatId" TEXT,
  ADD COLUMN "lastDeliveryStatus" TEXT,
  ADD COLUMN "lastDeliveryError" TEXT,
  ADD COLUMN "lastDeliveryAt" TIMESTAMP(3),
  ADD COLUMN "lastDeliveryText" TEXT;

ALTER TABLE "AgentTrigger" ADD CONSTRAINT "AgentTrigger_deliveryConnectionId_fkey"
  FOREIGN KEY ("deliveryConnectionId") REFERENCES "AgentChannelConnection"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Conversation_agentId_triggerId_idx" ON "Conversation"("agentId", "triggerId");

-- Keep history classified even if its trigger has since been deleted.
UPDATE "Conversation" AS conversation
SET "triggerId" = task.grant->'entryPolicy'->>'sourceId'
FROM "A2ATask" AS task
JOIN "A2AContext" AS context ON context.id = task."contextId"
WHERE task.grant->'entryPolicy'->>'kind' = 'trigger'
  AND task.grant->'entryPolicy'->>'conversationId' = conversation.id
  AND NULLIF(task.grant->'entryPolicy'->>'sourceId', '') IS NOT NULL
  AND context."agentId" = conversation."agentId";

UPDATE "Conversation" AS conversation
SET "triggerId" = trigger.id
FROM "AgentTrigger" AS trigger
WHERE trigger."lastConversationId" = conversation.id
  AND trigger."agentId" = conversation."agentId"
  AND conversation."triggerId" IS NULL;
