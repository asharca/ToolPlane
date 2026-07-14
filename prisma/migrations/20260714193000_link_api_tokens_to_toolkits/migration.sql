-- Link install-issued API tokens to their toolkit so deletion revokes access.
ALTER TABLE "ApiToken" ADD COLUMN "toolkitId" TEXT;

CREATE INDEX "ApiToken_toolkitId_idx" ON "ApiToken"("toolkitId");

ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_toolkitId_fkey"
FOREIGN KEY ("toolkitId") REFERENCES "Toolkit"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
