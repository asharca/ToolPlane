ALTER TABLE "ChatMessage"
  ADD COLUMN "siblingGroupId" TEXT,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'success',
  ADD COLUMN "modelId" TEXT;

WITH sibling_groups AS (
  SELECT
    "threadId",
    "parentId",
    "role",
    md5("threadId" || ':' || COALESCE("parentId", 'root') || ':' || "role") AS group_id
  FROM "ChatMessage"
  GROUP BY "threadId", "parentId", "role"
  HAVING COUNT(*) > 1
)
UPDATE "ChatMessage" AS message
SET "siblingGroupId" = sibling_groups.group_id
FROM sibling_groups
WHERE message."threadId" = sibling_groups."threadId"
  AND message."parentId" IS NOT DISTINCT FROM sibling_groups."parentId"
  AND message."role" = sibling_groups."role";

UPDATE "ChatMessage" AS message
SET "modelId" = assistant."model"
FROM "ChatThread" AS thread
JOIN "ChatAssistant" AS assistant ON assistant."id" = thread."assistantId"
WHERE message."threadId" = thread."id"
  AND message."role" = 'assistant'
  AND assistant."model" IS NOT NULL;

CREATE INDEX "ChatMessage_threadId_siblingGroupId_createdAt_idx"
  ON "ChatMessage"("threadId", "siblingGroupId", "createdAt");
