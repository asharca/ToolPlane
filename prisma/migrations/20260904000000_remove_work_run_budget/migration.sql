ALTER TABLE "WorkSession" DROP CONSTRAINT IF EXISTS "WorkSession_budget_check";

ALTER TABLE "WorkSession"
  DROP COLUMN "maxSteps",
  DROP COLUMN "stepCount",
  DROP COLUMN "deadlineAt";

UPDATE "Agent" SET "maxSteps" = 100 WHERE "maxSteps" < 1;
UPDATE "AgentEndpointRevision" SET "maxSteps" = 100 WHERE "maxSteps" < 1;

ALTER TABLE "Agent" ALTER COLUMN "maxSteps" SET DEFAULT 100;
ALTER TABLE "ChatAssistant" ALTER COLUMN "maxSteps" SET DEFAULT 100;
ALTER TABLE "AgentEndpointRevision" ALTER COLUMN "maxSteps" SET DEFAULT 100;
