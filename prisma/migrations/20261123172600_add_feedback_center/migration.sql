-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT,
    "failureCode" TEXT,
    "failureReason" TEXT,
    "executionStage" TEXT,
    "fingerprint" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "platformVersion" TEXT,
    "conversationSnippet" JSONB,
    "workspaceId" TEXT,
    "agentId" TEXT,
    "conversationId" TEXT,
    "taskId" TEXT,
    "workSessionId" TEXT,
    "submittedById" TEXT,
    "approvedById" TEXT,
    "adminNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedbackOccurrence" (
    "id" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "agentId" TEXT,
    "conversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Feedback_fingerprint_key" ON "Feedback"("fingerprint");

-- CreateIndex
CREATE INDEX "Feedback_source_status_updatedAt_idx" ON "Feedback"("source", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "Feedback_submittedById_createdAt_idx" ON "Feedback"("submittedById", "createdAt");

-- CreateIndex
CREATE INDEX "Feedback_approvedById_createdAt_idx" ON "Feedback"("approvedById", "createdAt");

-- CreateIndex
CREATE INDEX "Feedback_workspaceId_updatedAt_idx" ON "Feedback"("workspaceId", "updatedAt");

-- CreateIndex
CREATE INDEX "Feedback_conversationId_idx" ON "Feedback"("conversationId");

-- CreateIndex
CREATE INDEX "FeedbackOccurrence_sourceKind_sourceId_idx" ON "FeedbackOccurrence"("sourceKind", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackOccurrence_feedbackId_sourceKind_sourceId_key" ON "FeedbackOccurrence"("feedbackId", "sourceKind", "sourceId");

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackOccurrence" ADD CONSTRAINT "FeedbackOccurrence_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "Feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;
