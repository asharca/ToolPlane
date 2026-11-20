ALTER TABLE "GithubResourceSyncJob"
    ADD COLUMN "summary" JSONB,
    ADD COLUMN "failedPath" TEXT,
    ADD COLUMN "retried" BOOLEAN NOT NULL DEFAULT false;
