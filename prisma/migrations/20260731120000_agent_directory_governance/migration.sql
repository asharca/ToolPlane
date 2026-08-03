-- Agent listings are directory templates. Their public identity and lifecycle
-- no longer depend on the workspace/user that originally submitted them.
ALTER TABLE "AgentListing" DROP CONSTRAINT "AgentListing_publisherWorkspaceId_fkey";
ALTER TABLE "AgentListing" DROP CONSTRAINT "AgentListing_publishedById_fkey";
ALTER TABLE "AgentInstall" DROP CONSTRAINT "AgentInstall_installedById_fkey";
ALTER TABLE "AgentInstall" DROP CONSTRAINT "AgentInstall_releaseId_fkey";

ALTER TABLE "AgentListing"
  ALTER COLUMN "publisherWorkspaceId" DROP NOT NULL,
  ALTER COLUMN "publishedById" DROP NOT NULL,
  ADD COLUMN "directorySlug" TEXT,
  ADD COLUMN "author" TEXT,
  ADD COLUMN "curated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isFeatured" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pendingReleaseId" TEXT;

ALTER TABLE "AgentRelease"
  ADD COLUMN "name" TEXT,
  ADD COLUMN "summary" TEXT,
  ADD COLUMN "iconUrl" TEXT,
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewNote" TEXT;

-- Keep immutable install history and idempotency records when an installer
-- account is deleted. The target workspace remains the authorization scope.
ALTER TABLE "AgentInstall" ALTER COLUMN "installedById" DROP NOT NULL;

-- Existing listings were already public before review support existed. Give
-- each one a collision-free global directory slug and approve its releases.
UPDATE "AgentListing" AS listing
SET
  "directorySlug" = LEFT(
    listing."slug",
    GREATEST(1, 120 - 1 - char_length(listing."id"))
  ) || '-' || listing."id",
  "author" = workspace."name"
FROM "Workspace" AS workspace
WHERE workspace."id" = listing."publisherWorkspaceId";

UPDATE "AgentRelease" AS release
SET
  "name" = listing."name",
  "summary" = listing."summary",
  "iconUrl" = listing."iconUrl",
  "tags" = COALESCE(listing."tags", ARRAY[]::TEXT[]),
  "reviewStatus" = 'approved',
  "reviewedAt" = release."publishedAt"
FROM "AgentListing" AS listing
WHERE listing."id" = release."listingId";

UPDATE "AgentListing" SET "tags" = ARRAY[]::TEXT[] WHERE "tags" IS NULL;
ALTER TABLE "AgentListing" ALTER COLUMN "tags" SET NOT NULL;
ALTER TABLE "AgentListing" ALTER COLUMN "directorySlug" SET NOT NULL;
ALTER TABLE "AgentRelease" ALTER COLUMN "name" SET NOT NULL;

-- Shared directory categories, matching MCP servers and skills.
CREATE TABLE "_AgentListingCategories" (
  "A" TEXT NOT NULL,
  "B" TEXT NOT NULL,
  CONSTRAINT "_AgentListingCategories_AB_pkey" PRIMARY KEY ("A", "B")
);

DROP INDEX "AgentListing_status_installCount_publishedAt_idx";

CREATE UNIQUE INDEX "AgentListing_directorySlug_key" ON "AgentListing"("directorySlug");
CREATE UNIQUE INDEX "AgentListing_pendingReleaseId_key" ON "AgentListing"("pendingReleaseId");
CREATE INDEX "AgentListing_status_isFeatured_installCount_publishedAt_idx"
  ON "AgentListing"("status", "isFeatured", "installCount", "publishedAt");
CREATE INDEX "AgentListing_pendingReleaseId_updatedAt_idx"
  ON "AgentListing"("pendingReleaseId", "updatedAt");
CREATE INDEX "AgentRelease_reviewStatus_publishedAt_idx"
  ON "AgentRelease"("reviewStatus", "publishedAt");
CREATE INDEX "AgentRelease_reviewedById_idx" ON "AgentRelease"("reviewedById");
CREATE INDEX "_AgentListingCategories_B_index" ON "_AgentListingCategories"("B");

ALTER TABLE "AgentListing"
  ADD CONSTRAINT "AgentListing_publisherWorkspaceId_fkey"
  FOREIGN KEY ("publisherWorkspaceId") REFERENCES "Workspace"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentListing"
  ADD CONSTRAINT "AgentListing_publishedById_fkey"
  FOREIGN KEY ("publishedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentListing"
  ADD CONSTRAINT "AgentListing_pendingReleaseId_fkey"
  FOREIGN KEY ("pendingReleaseId") REFERENCES "AgentRelease"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentRelease"
  ADD CONSTRAINT "AgentRelease_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentInstall"
  ADD CONSTRAINT "AgentInstall_installedById_fkey"
  FOREIGN KEY ("installedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentInstall"
  ADD CONSTRAINT "AgentInstall_releaseId_fkey"
  FOREIGN KEY ("releaseId") REFERENCES "AgentRelease"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "_AgentListingCategories"
  ADD CONSTRAINT "_AgentListingCategories_A_fkey"
  FOREIGN KEY ("A") REFERENCES "AgentListing"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_AgentListingCategories"
  ADD CONSTRAINT "_AgentListingCategories_B_fkey"
  FOREIGN KEY ("B") REFERENCES "Category"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
