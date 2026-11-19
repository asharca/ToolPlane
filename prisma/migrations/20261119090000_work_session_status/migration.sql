-- Keep the shadow diff's enum, but cast the existing column in place instead of
-- recreating it (which would reset every Work status to queued).
BEGIN;

CREATE TYPE "WorkSessionStatus" AS ENUM (
  'idle', 'queued', 'running', 'waiting_user', 'cancelling',
  'completed', 'failed', 'cancelled', 'archived', 'forking'
);

CREATE TYPE "WorkspaceStatus" AS ENUM ('active', 'deleting', 'delete_failed');

LOCK TABLE "Workspace", "WorkSession" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "WorkSession"
    WHERE "status" NOT IN (
      'idle', 'queued', 'running', 'waiting_user', 'cancelling',
      'completed', 'failed', 'cancelled', 'archived'
    )
  ) THEN
    RAISE EXCEPTION 'Unexpected WorkSession status; resolve it before migrating';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "Workspace"
    WHERE "status" NOT IN ('active', 'deleting', 'delete_failed')
  ) THEN
    RAISE EXCEPTION 'Unexpected Workspace status; resolve it before migrating';
  END IF;
END $$;

ALTER TABLE "WorkSession" DROP CONSTRAINT "WorkSession_status_check";
ALTER TABLE "WorkSession" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "WorkSession" ALTER COLUMN "status" TYPE "WorkSessionStatus"
  USING ("status"::"WorkSessionStatus");
ALTER TABLE "WorkSession" ALTER COLUMN "status" SET DEFAULT 'queued';

ALTER TABLE "Workspace" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Workspace" ALTER COLUMN "status" TYPE "WorkspaceStatus"
  USING ("status"::"WorkspaceStatus");
ALTER TABLE "Workspace" ALTER COLUMN "status" SET DEFAULT 'active';

-- Historical exceptions were free text and may contain sensitive details.
UPDATE "WorkSession"
SET "error" = CASE
  WHEN "error" = 'Work was interrupted by a server restart. Review the transcript, then resume it.'
    THEN 'WORK_INTERRUPTED'
  ELSE 'WORK_EXECUTION_FAILED'
END
WHERE "error" IS NOT NULL;

COMMIT;
