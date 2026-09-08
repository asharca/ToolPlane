-- DropForeignKey
ALTER TABLE "RequestLog" DROP CONSTRAINT "RequestLog_workspaceId_fkey";

-- DropTable
DROP TABLE "RequestLog";

-- CreateTable
CREATE TABLE "LogEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL DEFAULT 'info',
    "domain" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'success',
    "requestId" TEXT,
    "traceId" TEXT NOT NULL,
    "spanId" TEXT NOT NULL,
    "parentSpanId" TEXT,
    "actorId" TEXT,
    "workspaceId" TEXT,
    "deploymentId" TEXT,
    "agentId" TEXT,
    "runId" TEXT,
    "conversationId" TEXT,
    "channelId" TEXT,
    "providerId" TEXT,
    "model" TEXT,
    "method" TEXT,
    "path" TEXT,
    "httpStatus" INTEGER,
    "rpcMethod" TEXT,
    "toolName" TEXT,
    "durationMs" INTEGER,
    "errorType" TEXT,
    "errorCode" TEXT,
    "attributes" JSONB,

    CONSTRAINT "LogEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LogDetail" (
    "eventId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LogDetail_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'success',
    "traceId" TEXT NOT NULL,
    "requestId" TEXT,
    "changes" JSONB,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LogEvent_createdAt_id_idx" ON "LogEvent"("createdAt", "id");

-- CreateIndex
CREATE INDEX "LogEvent_workspaceId_createdAt_id_idx" ON "LogEvent"("workspaceId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "LogEvent_workspaceId_deploymentId_createdAt_id_idx" ON "LogEvent"("workspaceId", "deploymentId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "LogEvent_traceId_createdAt_id_idx" ON "LogEvent"("traceId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "LogEvent_requestId_idx" ON "LogEvent"("requestId");

-- CreateIndex
CREATE INDEX "LogEvent_domain_level_createdAt_idx" ON "LogEvent"("domain", "level", "createdAt");

-- CreateIndex
CREATE INDEX "LogEvent_agentId_createdAt_idx" ON "LogEvent"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "LogEvent_runId_createdAt_idx" ON "LogEvent"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "LogEvent_channelId_createdAt_idx" ON "LogEvent"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "LogDetail_expiresAt_idx" ON "LogDetail"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_id_idx" ON "AuditEvent"("createdAt", "id");

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_createdAt_id_idx" ON "AuditEvent"("workspaceId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_createdAt_idx" ON "AuditEvent"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_traceId_idx" ON "AuditEvent"("traceId");

-- AddForeignKey
ALTER TABLE "LogDetail" ADD CONSTRAINT "LogDetail_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "LogEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
