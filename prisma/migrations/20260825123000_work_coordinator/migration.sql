ALTER TABLE "WorkSession"
  ADD COLUMN "acceptanceCriteria" TEXT,
  ADD COLUMN "runtimeKind" TEXT NOT NULL DEFAULT 'native',
  ADD COLUMN "runtimeSnapshot" JSONB,
  ADD COLUMN "maxSteps" INTEGER NOT NULL DEFAULT 12,
  ADD COLUMN "stepCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "waitingQuestion" TEXT,
  ADD COLUMN "artifacts" JSONB,
  ADD COLUMN "deadlineAt" TIMESTAMP(3),
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3);

UPDATE "WorkSession"
SET "status" = CASE
  WHEN "status" IN ('completed', 'failed', 'cancelled', 'archived') THEN "status"
  ELSE 'queued'
END;

ALTER TABLE "WorkSession" ALTER COLUMN "status" SET DEFAULT 'queued';
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_status_check"
  CHECK ("status" IN ('queued', 'running', 'waiting_user', 'waiting_approval', 'completed', 'failed', 'cancelled', 'archived'));
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_budget_check"
  CHECK ("maxSteps" BETWEEN 1 AND 100 AND "stepCount" >= 0);

CREATE TABLE "WorkApproval" (
  "id" TEXT NOT NULL,
  "workSessionId" TEXT NOT NULL,
  "toolCallId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "input" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "resolvedById" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "WorkApproval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkApproval_status_check" CHECK ("status" IN ('pending', 'allowed', 'denied', 'expired'))
);

CREATE UNIQUE INDEX "WorkApproval_workSessionId_toolCallId_key" ON "WorkApproval"("workSessionId", "toolCallId");
CREATE INDEX "WorkApproval_workSessionId_status_requestedAt_idx" ON "WorkApproval"("workSessionId", "status", "requestedAt");
CREATE INDEX "WorkApproval_resolvedById_idx" ON "WorkApproval"("resolvedById");
ALTER TABLE "WorkApproval" ADD CONSTRAINT "WorkApproval_workSessionId_fkey" FOREIGN KEY ("workSessionId") REFERENCES "WorkSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkApproval" ADD CONSTRAINT "WorkApproval_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
