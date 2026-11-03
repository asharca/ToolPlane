BEGIN;

ALTER TABLE "Agent" ADD COLUMN "retiredAt" TIMESTAMP(3), ADD COLUMN "currentRevisionVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Agent" ADD COLUMN "a2aInboundEnabled" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "a2aOutboundEnabled" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "a2aPolicy" JSONB;
ALTER TABLE "ChatAssistant" ADD COLUMN "currentRevisionVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_current_revision_nonnegative" CHECK ("currentRevisionVersion" >= 0);
ALTER TABLE "ChatAssistant" ADD CONSTRAINT "ChatAssistant_current_revision_nonnegative" CHECK ("currentRevisionVersion" >= 0);
ALTER TABLE "ChatAssistantMcpGrant" ADD COLUMN "allowedToolNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "ChatAssistantRevision" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "assistantId" TEXT NOT NULL REFERENCES "ChatAssistant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "config" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatAssistantRevision_config_shape" CHECK (jsonb_typeof("config") = 'object' AND COALESCE("config"->>'schemaVersion' = '1', false))
);
CREATE UNIQUE INDEX "ChatAssistantRevision_assistantId_id_key" ON "ChatAssistantRevision"("assistantId", "id");
CREATE UNIQUE INDEX "ChatAssistantRevision_assistantId_version_key" ON "ChatAssistantRevision"("assistantId", "version");

CREATE TABLE "AgentRevision" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "agentId" TEXT NOT NULL REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "config" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentRevision_config_shape" CHECK (jsonb_typeof("config") = 'object' AND COALESCE("config"->>'schemaVersion' = '1', false))
);
CREATE UNIQUE INDEX "AgentRevision_agentId_id_key" ON "AgentRevision"("agentId", "id");
CREATE UNIQUE INDEX "AgentRevision_agentId_version_key" ON "AgentRevision"("agentId", "version");

-- No historical configuration can be reconstructed from today's mutable row.
-- Existing rows stay explicitly unresolved; only new sessions may pin revisions.
ALTER TABLE "ChatThread" ADD COLUMN "assistantRevisionId" TEXT, ADD COLUMN "legacyRevisionUnresolved" BOOLEAN NOT NULL DEFAULT true,
  ADD CONSTRAINT "ChatThread_assistantId_assistantRevisionId_fkey" FOREIGN KEY ("assistantId", "assistantRevisionId") REFERENCES "ChatAssistantRevision"("assistantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatThread_revision_resolution" CHECK ("legacyRevisionUnresolved" = ("assistantRevisionId" IS NULL));
CREATE INDEX "ChatThread_assistantId_assistantRevisionId_idx" ON "ChatThread"("assistantId", "assistantRevisionId");
ALTER TABLE "Conversation" ADD COLUMN "agentRevisionId" TEXT, ADD COLUMN "legacyRevisionUnresolved" BOOLEAN NOT NULL DEFAULT true,
  ADD CONSTRAINT "Conversation_agentId_agentRevisionId_fkey" FOREIGN KEY ("agentId", "agentRevisionId") REFERENCES "AgentRevision"("agentId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "Conversation_revision_resolution" CHECK ("legacyRevisionUnresolved" = ("agentRevisionId" IS NULL));
CREATE INDEX "Conversation_agentId_agentRevisionId_idx" ON "Conversation"("agentId", "agentRevisionId");
ALTER TABLE "WorkSession" ADD COLUMN "agentRevisionId" TEXT, ADD COLUMN "legacyRevisionUnresolved" BOOLEAN NOT NULL DEFAULT true,
  ADD CONSTRAINT "WorkSession_agentId_agentRevisionId_fkey" FOREIGN KEY ("agentId", "agentRevisionId") REFERENCES "AgentRevision"("agentId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "WorkSession_revision_resolution" CHECK ("legacyRevisionUnresolved" = ("agentRevisionId" IS NULL));
CREATE INDEX "WorkSession_agentId_agentRevisionId_idx" ON "WorkSession"("agentId", "agentRevisionId");
ALTER TABLE "A2AContext" ADD COLUMN "agentRevisionId" TEXT, ADD COLUMN "legacyRevisionUnresolved" BOOLEAN NOT NULL DEFAULT true,
  ADD CONSTRAINT "A2AContext_agentId_agentRevisionId_fkey" FOREIGN KEY ("agentId", "agentRevisionId") REFERENCES "AgentRevision"("agentId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "A2AContext_revision_resolution" CHECK ("legacyRevisionUnresolved" = ("agentRevisionId" IS NULL) AND ("agentRevisionId" IS NULL OR ("agentId" IS NOT NULL AND "targetKind" = 'local')));
CREATE INDEX "A2AContext_agentId_agentRevisionId_idx" ON "A2AContext"("agentId", "agentRevisionId");

ALTER TABLE "ChatTurn"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "requestHash" TEXT,
  ADD COLUMN "actorUserId" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0 CHECK ("generation" >= 0),
  ADD COLUMN "lastEventSequence" INTEGER NOT NULL DEFAULT 0 CHECK ("lastEventSequence" >= 0),
  ADD COLUMN "stopRequestedAt" TIMESTAMP(3),
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "errorAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT "ChatTurn_idempotency_pair" CHECK (("idempotencyKey" IS NULL) = ("requestHash" IS NULL)),
  ADD CONSTRAINT "ChatTurn_lease_pair" CHECK (("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL));
CREATE UNIQUE INDEX "ChatTurn_threadId_idempotencyKey_key" ON "ChatTurn"("threadId", "idempotencyKey");
CREATE INDEX "ChatTurn_status_leaseExpiresAt_idx" ON "ChatTurn"("status", "leaseExpiresAt");
CREATE INDEX "ChatTurn_actorUserId_idx" ON "ChatTurn"("actorUserId");

CREATE TABLE "ChatRunEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "turnId" TEXT NOT NULL REFERENCES "ChatTurn"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sequence" INTEGER NOT NULL CHECK ("sequence" > 0),
  "generation" INTEGER NOT NULL CHECK ("generation" >= 0),
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ChatRunEvent_turnId_sequence_key" ON "ChatRunEvent"("turnId", "sequence");
CREATE TABLE "ChatToolConfirmation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "turnId" TEXT NOT NULL REFERENCES "ChatTurn"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "toolCallId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "input" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'awaiting_user' CHECK ("status" IN ('awaiting_user', 'approved', 'rejected', 'executing', 'execution_unknown', 'succeeded', 'failed')),
  "approverUserId" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "resolvedAt" TIMESTAMP(3),
  "executionStartedAt" TIMESTAMP(3),
  "executionCompletedAt" TIMESTAMP(3),
  "result" JSONB,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ChatToolConfirmation_turnId_toolCallId_key" ON "ChatToolConfirmation"("turnId", "toolCallId");
CREATE INDEX "ChatToolConfirmation_turnId_status_createdAt_idx" ON "ChatToolConfirmation"("turnId", "status", "createdAt");
CREATE INDEX "ChatToolConfirmation_approverUserId_idx" ON "ChatToolConfirmation"("approverUserId");

CREATE FUNCTION capability_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'configuration revisions and run events are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "AgentRevision_immutable" BEFORE UPDATE ON "AgentRevision" FOR EACH ROW EXECUTE FUNCTION capability_revision_immutable();
CREATE TRIGGER "ChatAssistantRevision_immutable" BEFORE UPDATE ON "ChatAssistantRevision" FOR EACH ROW EXECUTE FUNCTION capability_revision_immutable();
CREATE TRIGGER "ChatRunEvent_immutable" BEFORE UPDATE ON "ChatRunEvent" FOR EACH ROW EXECUTE FUNCTION capability_revision_immutable();

-- Immutable children are removed only by deleting their retained parent.
CREATE FUNCTION capability_retained_child_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_exists boolean;
BEGIN
  IF TG_TABLE_NAME = 'AgentRevision' THEN
    SELECT EXISTS(SELECT 1 FROM "Agent" WHERE "id" = OLD."agentId") INTO parent_exists;
  ELSIF TG_TABLE_NAME = 'ChatAssistantRevision' THEN
    SELECT EXISTS(SELECT 1 FROM "ChatAssistant" WHERE "id" = OLD."assistantId") INTO parent_exists;
  ELSE
    SELECT EXISTS(SELECT 1 FROM "ChatTurn" WHERE "id" = OLD."turnId") INTO parent_exists;
  END IF;
  IF parent_exists THEN RAISE EXCEPTION 'delete the retained parent, not immutable history' USING ERRCODE = '23514'; END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER "AgentRevision_retention" BEFORE DELETE ON "AgentRevision" FOR EACH ROW EXECUTE FUNCTION capability_retained_child_delete();
CREATE TRIGGER "ChatAssistantRevision_retention" BEFORE DELETE ON "ChatAssistantRevision" FOR EACH ROW EXECUTE FUNCTION capability_retained_child_delete();
CREATE TRIGGER "ChatRunEvent_retention" BEFORE DELETE ON "ChatRunEvent" FOR EACH ROW EXECUTE FUNCTION capability_retained_child_delete();

CREATE FUNCTION capability_revision_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_version integer;
BEGIN
  IF TG_TABLE_NAME = 'AgentRevision' THEN
    PERFORM 1 FROM "Agent" WHERE "id" = NEW."agentId" FOR UPDATE;
    SELECT COALESCE(MAX("version"), 0) INTO previous_version FROM "AgentRevision" WHERE "agentId" = NEW."agentId";
  ELSE
    PERFORM 1 FROM "ChatAssistant" WHERE "id" = NEW."assistantId" FOR UPDATE;
    SELECT COALESCE(MAX("version"), 0) INTO previous_version FROM "ChatAssistantRevision" WHERE "assistantId" = NEW."assistantId";
  END IF;
  IF NEW."version" <> previous_version + 1 THEN
    RAISE EXCEPTION 'revision versions must increase by one per owner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AgentRevision_version" BEFORE INSERT ON "AgentRevision" FOR EACH ROW EXECUTE FUNCTION capability_revision_version();
CREATE TRIGGER "ChatAssistantRevision_version" BEFORE INSERT ON "ChatAssistantRevision" FOR EACH ROW EXECUTE FUNCTION capability_revision_version();

CREATE FUNCTION capability_current_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision_exists boolean;
BEGIN
  IF NEW."currentRevisionVersion" < OLD."currentRevisionVersion" THEN
    RAISE EXCEPTION 'current revision cannot move backwards' USING ERRCODE = '23514';
  END IF;
  IF NEW."currentRevisionVersion" = 0 THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'Agent' THEN
    SELECT EXISTS(SELECT 1 FROM "AgentRevision" WHERE "agentId" = NEW."id" AND "version" = NEW."currentRevisionVersion") INTO revision_exists;
  ELSE
    SELECT EXISTS(SELECT 1 FROM "ChatAssistantRevision" WHERE "assistantId" = NEW."id" AND "version" = NEW."currentRevisionVersion") INTO revision_exists;
  END IF;
  IF NOT revision_exists THEN RAISE EXCEPTION 'current revision must exist for owner' USING ERRCODE = '23503'; END IF;
  RETURN NEW;
END;
$$;
-- Owners are created before their first revision; publication is transactional.
CREATE FUNCTION capability_initial_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."currentRevisionVersion" <> 0 THEN
    RAISE EXCEPTION 'new owner must publish its first revision transactionally' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Agent_initial_revision" BEFORE INSERT ON "Agent" FOR EACH ROW EXECUTE FUNCTION capability_initial_revision();
CREATE TRIGGER "ChatAssistant_initial_revision" BEFORE INSERT ON "ChatAssistant" FOR EACH ROW EXECUTE FUNCTION capability_initial_revision();
CREATE TRIGGER "Agent_current_revision" BEFORE UPDATE OF "currentRevisionVersion" ON "Agent" FOR EACH ROW EXECUTE FUNCTION capability_current_revision();
CREATE TRIGGER "ChatAssistant_current_revision" BEFORE UPDATE OF "currentRevisionVersion" ON "ChatAssistant" FOR EACH ROW EXECUTE FUNCTION capability_current_revision();

-- An unresolved historical session can never be rebound to a guessed revision.
CREATE FUNCTION capability_session_pin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'ChatThread' THEN
    IF (OLD."assistantId", OLD."assistantRevisionId", OLD."legacyRevisionUnresolved") IS DISTINCT FROM (NEW."assistantId", NEW."assistantRevisionId", NEW."legacyRevisionUnresolved") THEN
      RAISE EXCEPTION 'session owner and revision are immutable; create a new session' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (OLD."agentId", OLD."agentRevisionId", OLD."legacyRevisionUnresolved") IS DISTINCT FROM (NEW."agentId", NEW."agentRevisionId", NEW."legacyRevisionUnresolved") THEN
      RAISE EXCEPTION 'session owner and revision are immutable; create a new session' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChatThread_revision_pin" BEFORE UPDATE ON "ChatThread" FOR EACH ROW EXECUTE FUNCTION capability_session_pin_immutable();
CREATE TRIGGER "Conversation_revision_pin" BEFORE UPDATE ON "Conversation" FOR EACH ROW EXECUTE FUNCTION capability_session_pin_immutable();
CREATE TRIGGER "WorkSession_revision_pin" BEFORE UPDATE ON "WorkSession" FOR EACH ROW EXECUTE FUNCTION capability_session_pin_immutable();
CREATE TRIGGER "A2AContext_revision_pin" BEFORE UPDATE ON "A2AContext" FOR EACH ROW EXECUTE FUNCTION capability_session_pin_immutable();

-- Append and advance the cursor atomically. Callers supply lastEventSequence+1;
-- they must not separately increment lastEventSequence before inserting.
CREATE FUNCTION capability_chat_event_append() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_sequence integer; current_generation integer;
BEGIN
  SELECT "lastEventSequence", "generation" INTO current_sequence, current_generation FROM "ChatTurn" WHERE "id" = NEW."turnId" FOR UPDATE;
  IF NEW."sequence" <> current_sequence + 1 OR NEW."generation" <> current_generation THEN
    RAISE EXCEPTION 'event sequence or execution generation conflict' USING ERRCODE = '23514';
  END IF;
  UPDATE "ChatTurn" SET "lastEventSequence" = NEW."sequence" WHERE "id" = NEW."turnId";
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChatRunEvent_append" BEFORE INSERT ON "ChatRunEvent" FOR EACH ROW EXECUTE FUNCTION capability_chat_event_append();

CREATE FUNCTION capability_confirmation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."turnId", OLD."toolCallId", OLD."toolName", OLD."input") IS DISTINCT FROM (NEW."turnId", NEW."toolCallId", NEW."toolName", NEW."input") THEN
    RAISE EXCEPTION 'tool confirmation identity and input are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> NEW."status" AND NOT (
    (OLD."status" = 'awaiting_user' AND NEW."status" IN ('approved', 'rejected')) OR
    (OLD."status" = 'approved' AND NEW."status" = 'executing') OR
    (OLD."status" = 'executing' AND NEW."status" IN ('execution_unknown', 'succeeded', 'failed')) OR
    (OLD."status" = 'execution_unknown' AND NEW."status" IN ('succeeded', 'failed'))
  ) THEN
    RAISE EXCEPTION 'unsafe tool confirmation transition; reconcile unknown results without replay' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IN ('approved', 'rejected') AND (NEW."approverUserId" IS NULL OR NEW."resolvedAt" IS NULL) THEN
    RAISE EXCEPTION 'tool decision requires user identity and timestamp' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChatToolConfirmation_transition" BEFORE UPDATE ON "ChatToolConfirmation" FOR EACH ROW EXECUTE FUNCTION capability_confirmation_transition();

CREATE FUNCTION capability_confirmation_initial() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'awaiting_user' OR NEW."approverUserId" IS NOT NULL OR NEW."resolvedAt" IS NOT NULL OR NEW."executionStartedAt" IS NOT NULL OR NEW."executionCompletedAt" IS NOT NULL OR NEW."result" IS NOT NULL THEN
    RAISE EXCEPTION 'new tool confirmations must await user approval' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChatToolConfirmation_initial" BEFORE INSERT ON "ChatToolConfirmation" FOR EACH ROW EXECUTE FUNCTION capability_confirmation_initial();

CREATE FUNCTION capability_turn_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."threadId", OLD."idempotencyKey", OLD."requestHash") IS DISTINCT FROM (NEW."threadId", NEW."idempotencyKey", NEW."requestHash") THEN
    RAISE EXCEPTION 'run identity and request hash are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."generation" < OLD."generation" THEN
    RAISE EXCEPTION 'execution generation cannot move backwards' USING ERRCODE = '23514';
  END IF;
  IF NEW."lastEventSequence" <> OLD."lastEventSequence" AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'event cursor advances only by appending an event' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChatTurn_identity" BEFORE UPDATE ON "ChatTurn" FOR EACH ROW EXECUTE FUNCTION capability_turn_identity();

COMMIT;
