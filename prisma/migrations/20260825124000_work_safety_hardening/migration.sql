-- Legacy Work was request-bound and did not persist safe tool checkpoints.
-- Require an explicit review/resume instead of replaying unknown side effects.
UPDATE "WorkSession"
SET
  "status" = 'failed',
  "error" = 'Legacy Work requires review before it can run in the durable coordinator.',
  "completedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'queued' AND "runtimeSnapshot" IS NULL;

ALTER TABLE "WorkSession" DROP CONSTRAINT "WorkSession_status_check";
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_status_check"
  CHECK ("status" IN ('queued', 'running', 'waiting_user', 'waiting_approval', 'cancelling', 'completed', 'failed', 'cancelled', 'archived'));

CREATE INDEX "WorkSession_status_createdAt_idx" ON "WorkSession"("status", "createdAt");
