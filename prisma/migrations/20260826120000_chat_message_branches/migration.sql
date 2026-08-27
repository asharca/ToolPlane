ALTER TABLE "ChatThread" ADD COLUMN "activeMessageId" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN "parentId" TEXT;

WITH ordered_messages AS (
  SELECT
    message."id",
    LAG(message."id") OVER (
      PARTITION BY message."threadId"
      ORDER BY message."createdAt", CASE WHEN message."role" = 'user' THEN 0 ELSE 1 END, message."id"
    ) AS "parentId"
  FROM "ChatMessage" AS message
)
UPDATE "ChatMessage" AS message
SET "parentId" = ordered."parentId"
FROM ordered_messages AS ordered
WHERE message."id" = ordered."id";

WITH active_messages AS (
  SELECT DISTINCT ON (message."threadId")
    message."threadId",
    message."id"
  FROM "ChatMessage" AS message
  ORDER BY message."threadId", message."createdAt" DESC, message."id" DESC
)
UPDATE "ChatThread" AS thread
SET "activeMessageId" = active."id"
FROM active_messages AS active
WHERE thread."id" = active."threadId";

CREATE INDEX "ChatMessage_threadId_parentId_createdAt_idx"
  ON "ChatMessage"("threadId", "parentId", "createdAt");

ALTER TABLE "ChatMessage"
  ADD CONSTRAINT "ChatMessage_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "ChatMessage"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
