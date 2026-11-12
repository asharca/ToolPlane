BEGIN;
ALTER TABLE "AgentRevision" ADD COLUMN "parentRevisionId" TEXT, ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'published';
ALTER TABLE "AgentRevision" ADD CONSTRAINT "AgentRevision_parent_owner" FOREIGN KEY ("agentId", "parentRevisionId") REFERENCES "AgentRevision"("agentId", "id") ON DELETE RESTRICT;
ALTER TABLE "AgentRevision" ADD CONSTRAINT "AgentRevision_purpose" CHECK ("purpose" IN ('published','candidate','rollback'));
CREATE TABLE "AgentEvolutionSettings" (
 "agentId" TEXT PRIMARY KEY REFERENCES "Agent"("id") ON DELETE CASCADE,
 "enabled" BOOLEAN NOT NULL DEFAULT false,
 "reflectionEnabled" BOOLEAN NOT NULL DEFAULT false,
 "reflectionIntervalHours" INTEGER NOT NULL DEFAULT 24 CHECK ("reflectionIntervalHours" BETWEEN 1 AND 8760),
 "nextReflectionAt" TIMESTAMP(3),
 "monthlyBudgetMicros" BIGINT NOT NULL DEFAULT 1000000 CHECK ("monthlyBudgetMicros" >= 0),
 "actorId" TEXT NOT NULL,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "AgentEvolutionRecord" (
 "id" TEXT PRIMARY KEY,
 "agentId" TEXT NOT NULL,
 "workspaceId" TEXT NOT NULL,
 "kind" TEXT NOT NULL CHECK ("kind" IN ('episode','episode-ingest','tool-call','isolation-container','playbook','playbook-version','turn','proposal','case','evaluation','result','reflection','rollout','charge')),
 "key" TEXT NOT NULL,
 "status" TEXT NOT NULL,
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version">0),
 "payload" JSONB NOT NULL,
 "actorId" TEXT NOT NULL,
 "costMicros" BIGINT NOT NULL DEFAULT 0 CHECK ("costMicros">=0),
 "leaseToken" TEXT,
 "leaseExpiresAt" TIMESTAMP(3),
 "failureCode" TEXT,
 "completedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "AgentEvolutionRecord_agent_owner" FOREIGN KEY ("agentId","workspaceId") REFERENCES "Agent"("id","workspaceId") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "AgentEvolutionRecord_agentId_kind_key_key" ON "AgentEvolutionRecord"("agentId","kind","key");
CREATE UNIQUE INDEX "AgentEvolutionRecord_active_rollout" ON "AgentEvolutionRecord"("agentId") WHERE "kind"='rollout' AND "status"='active';
CREATE INDEX "AgentEvolutionRecord_agentId_kind_createdAt_idx" ON "AgentEvolutionRecord"("agentId","kind","createdAt");
CREATE INDEX "AgentEvolutionRecord_kind_status_leaseExpiresAt_idx" ON "AgentEvolutionRecord"("kind","status","leaseExpiresAt");
CREATE TABLE "AgentMessageFeedback" (
 "id" TEXT PRIMARY KEY,
 "messageId" TEXT NOT NULL REFERENCES "Message"("id") ON DELETE CASCADE,
 "createdById" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "rating" TEXT NOT NULL CHECK ("rating" IN ('positive','negative')),
 "comment" TEXT NOT NULL DEFAULT '',
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "AgentMessageFeedback_messageId_createdById_key" ON "AgentMessageFeedback"("messageId","createdById");
CREATE FUNCTION evolution_record_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD."agentId",OLD."workspaceId",OLD."kind",OLD."key",OLD."actorId") IS DISTINCT FROM (NEW."agentId",NEW."workspaceId",NEW."kind",NEW."key",NEW."actorId") THEN
  RAISE EXCEPTION 'evolution identity is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD."kind" IN ('episode','playbook-version','turn','result','charge') AND OLD IS DISTINCT FROM NEW THEN
  RAISE EXCEPTION 'evolution snapshots are immutable' USING ERRCODE='23514';
 END IF;
 IF OLD."kind" IN ('evaluation','reflection') AND OLD."status" IN ('succeeded','failed') AND OLD IS DISTINCT FROM NEW THEN
  RAISE EXCEPTION 'completed evolution jobs are immutable' USING ERRCODE='23514';
 END IF;
 IF OLD."kind"='proposal' AND OLD."status" <> 'pending' AND OLD IS DISTINCT FROM NEW THEN
 RAISE EXCEPTION 'reviewed proposals are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "AgentEvolutionRecord_immutable" BEFORE UPDATE ON "AgentEvolutionRecord" FOR EACH ROW EXECUTE FUNCTION evolution_record_immutable();
CREATE FUNCTION evolution_record_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."kind" <> 'episode-ingest' AND EXISTS(SELECT 1 FROM "Agent" WHERE "id"=OLD."agentId") AND EXISTS(SELECT 1 FROM "Workspace" WHERE "id"=OLD."workspaceId") THEN
 RAISE EXCEPTION 'delete the retained parent, not evolution history' USING ERRCODE='23514';
 END IF;
 RETURN OLD;
END; $$;
CREATE TRIGGER "AgentEvolutionRecord_retention" BEFORE DELETE ON "AgentEvolutionRecord" FOR EACH ROW EXECUTE FUNCTION evolution_record_retention();
COMMIT;
