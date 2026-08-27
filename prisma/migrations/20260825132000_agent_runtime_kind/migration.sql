ALTER TABLE "Agent"
ADD COLUMN "runtimeKind" TEXT NOT NULL DEFAULT 'pi';

UPDATE "Agent" AS agent
SET "runtimeKind" = 'hermes'
WHERE EXISTS (
  SELECT 1
  FROM "AgentRuntime" AS runtime
  WHERE runtime."agentId" = agent."id"
    AND runtime."kind" = 'hermes'
);

ALTER TABLE "Agent"
ADD CONSTRAINT "Agent_runtimeKind_check"
CHECK ("runtimeKind" IN ('pi', 'claude-code', 'dsh', 'hermes'));

UPDATE "WorkSession"
SET "runtimeKind" = 'pi'
WHERE "runtimeKind" = 'native';

ALTER TABLE "WorkSession"
ALTER COLUMN "runtimeKind" SET DEFAULT 'pi';
