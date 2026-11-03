-- Additive: existing Agent drafts and immutable Pi revisions are unchanged.
ALTER TABLE "Agent" ADD COLUMN "ompConfig" JSONB;
ALTER TABLE "Agent" DROP CONSTRAINT "Agent_runtimeKind_check";
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_runtimeKind_check"
CHECK ("runtimeKind" IN ('pi', 'pi-sdk', 'omp', 'claude-code', 'dsh'));
