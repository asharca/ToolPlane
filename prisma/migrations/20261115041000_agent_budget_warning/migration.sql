ALTER TABLE "AgentUsage"
  ADD COLUMN "meteringCompleted" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "budgetWarning" JSONB;
