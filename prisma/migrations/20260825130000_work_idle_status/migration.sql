ALTER TABLE "WorkSession" DROP CONSTRAINT "WorkSession_status_check";
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_status_check"
  CHECK ("status" IN ('idle', 'queued', 'running', 'waiting_user', 'waiting_approval', 'cancelling', 'completed', 'failed', 'cancelled', 'archived'));
