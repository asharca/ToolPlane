ALTER TABLE "A2ATask" ADD COLUMN "approvalReadyLease" TEXT;
CREATE TABLE "A2AToolApproval" (
  id TEXT PRIMARY KEY,
  "taskId" TEXT NOT NULL REFERENCES "A2ATask"(id) ON DELETE CASCADE,
  "leaseToken" TEXT NOT NULL,
  "callId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  input JSONB NOT NULL,
  "inputHash" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "decidedAt" TIMESTAMP(3),
  "decidedBy" TEXT,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "A2AToolApproval_status_check" CHECK (status IN ('pending','approved','denied','consumed','expired'))
);
CREATE UNIQUE INDEX "A2AToolApproval_taskId_leaseToken_callId_key" ON "A2AToolApproval"("taskId","leaseToken","callId");
CREATE INDEX "A2AToolApproval_taskId_status_idx" ON "A2AToolApproval"("taskId",status);
