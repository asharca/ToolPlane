BEGIN;

-- confirmations remains the effect ledger. Existing approval metadata is history,
-- not authority to execute after this cutover. Fence and fail legacy waiting Runs
-- without dispatching them, so they cannot permanently occupy a conversation.
LOCK TABLE "ChatTurn", "ChatToolConfirmation" IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE legacy_run RECORD;
BEGIN
  FOR legacy_run IN
    SELECT turn."id" FROM "ChatTurn" turn
    WHERE turn."status" = 'pending' AND EXISTS (
      SELECT 1 FROM "ChatToolConfirmation" confirmation
      WHERE confirmation."turnId" = turn."id"
        AND confirmation."status" IN ('awaiting_user', 'approved')
    )
    FOR UPDATE OF turn
  LOOP
    -- Another effect in the same Run may already have reached a remote server.
    UPDATE "ChatToolConfirmation"
    SET "status" = 'execution_unknown',
        "error" = 'Approval workflow retired during execution; reconcile externally, do not replay.'
    WHERE "turnId" = legacy_run."id" AND "status" = 'executing';
    UPDATE "ChatTurn"
    SET "status" = 'failed', "generation" = "generation" + 1,
        "leaseToken" = NULL, "leaseExpiresAt" = NULL,
        "error" = 'Approval workflow retired; pending tool requests were not executed.',
        "errorAt" = CURRENT_TIMESTAMP, "completedAt" = CURRENT_TIMESTAMP
    WHERE "id" = legacy_run."id";
    UPDATE "ChatMessage" SET "status" = 'failed'
    WHERE "turnId" = legacy_run."id" AND "role" = 'assistant' AND "status" = 'pending';
    INSERT INTO "ChatRunEvent" ("id", "turnId", "sequence", "generation", "payload", "createdAt")
    SELECT 'approval-cutover-' || "id", "id", "lastEventSequence" + 1, "generation",
      jsonb_build_object('type', 'error', 'errorText', "error"), CURRENT_TIMESTAMP
    FROM "ChatTurn" WHERE "id" = legacy_run."id";
  END LOOP;
END;
$$;

ALTER TABLE "ChatToolConfirmation" ALTER COLUMN "status" SET DEFAULT 'executing';

CREATE OR REPLACE FUNCTION capability_confirmation_initial() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'executing' OR NEW."executionStartedAt" IS NULL
    OR NEW."approverUserId" IS NOT NULL OR NEW."resolvedAt" IS NOT NULL
    OR NEW."executionCompletedAt" IS NOT NULL OR NEW."result" IS NOT NULL
    OR NEW."error" IS NOT NULL OR NEW."expiresAt" IS NOT NULL THEN
    RAISE EXCEPTION 'new tool effects require a direct execution claim, not user approval' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION capability_confirmation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."turnId", OLD."toolCallId", OLD."toolName", OLD."input") IS DISTINCT FROM (NEW."turnId", NEW."toolCallId", NEW."toolName", NEW."input") THEN
    RAISE EXCEPTION 'tool confirmation identity and input are immutable' USING ERRCODE = '23514';
  END IF;
  -- Old awaiting/approved/rejected rows remain historical and cannot be consumed.
  -- Executing claims can only settle; unknown effects require external reconciliation.
  IF OLD."status" <> NEW."status" AND NOT (
    (OLD."status" = 'executing' AND NEW."status" IN ('execution_unknown', 'succeeded', 'failed')) OR
    (OLD."status" = 'execution_unknown' AND NEW."status" IN ('succeeded', 'failed'))
  ) THEN
    RAISE EXCEPTION 'unsafe tool confirmation transition; reconcile unknown results without replay' USING ERRCODE = '23514';
  END IF;
  IF (NEW."approverUserId" IS NOT NULL AND NEW."approverUserId" IS DISTINCT FROM OLD."approverUserId")
    OR NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt" THEN
    RAISE EXCEPTION 'historical approval metadata is read-only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
