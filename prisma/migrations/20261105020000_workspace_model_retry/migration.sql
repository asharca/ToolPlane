ALTER TABLE "Workspace" ADD COLUMN "modelRetryAttempts" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_modelRetryAttempts_range"
  CHECK ("modelRetryAttempts" BETWEEN 0 AND 10);
