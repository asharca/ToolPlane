WITH ranked_pending AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "threadId"
      ORDER BY "createdAt" DESC, "id" DESC
    ) AS position
  FROM "ChatTurn"
  WHERE "status" = 'pending'
)
UPDATE "ChatTurn"
SET
  "status" = 'failed',
  "error" = 'Superseded by another pending chat turn.',
  "completedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (
  SELECT "id"
  FROM ranked_pending
  WHERE position > 1
);

CREATE UNIQUE INDEX "ChatTurn_one_pending_per_thread_key"
  ON "ChatTurn"("threadId")
  WHERE "status" = 'pending';
