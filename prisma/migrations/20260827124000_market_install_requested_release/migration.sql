ALTER TABLE "MarketInstall" ADD COLUMN "requestedReleaseId" TEXT;

UPDATE "MarketInstall"
SET "requestedReleaseId" = "currentReleaseId";

ALTER TABLE "MarketInstall"
  ALTER COLUMN "requestedReleaseId" SET NOT NULL;

CREATE INDEX "MarketInstall_requestedReleaseId_createdAt_idx"
  ON "MarketInstall"("requestedReleaseId", "createdAt");

ALTER TABLE "MarketInstall"
  ADD CONSTRAINT "MarketInstall_requestedReleaseId_fkey"
  FOREIGN KEY ("requestedReleaseId") REFERENCES "MarketRelease"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
