-- Native Pi owns tool decisions. These JSON values are bounded Web projections,
-- never a second session history or todo state machine.
ALTER TABLE "A2ATask" ADD COLUMN "uiProjection" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "WorkSession" ADD COLUMN "uiProjection" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "WorkSession" ADD COLUMN "uiLease" TEXT;
ALTER TABLE "A2ATask" DROP COLUMN "approvalReadyLease";

-- Keep historical decisions as evidence, outside the application's active schema.
-- Drain the previous runtime owner before applying this cutover.
CREATE SCHEMA IF NOT EXISTS toolplane_archive;
ALTER TABLE "A2AToolApproval" SET SCHEMA toolplane_archive;
ALTER TABLE "WorkApproval" SET SCHEMA toolplane_archive;
