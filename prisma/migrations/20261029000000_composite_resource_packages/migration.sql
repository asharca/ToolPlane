ALTER TABLE "MarketListing" ADD COLUMN "parentPackageListingId" TEXT, ADD COLUMN "packageMemberId" TEXT;
ALTER TABLE "MarketRelease" ADD COLUMN "parentPackageReleaseId" TEXT, ADD COLUMN "packageMemberId" TEXT;
ALTER TABLE "MarketInstall" ADD COLUMN "parentPackageInstallId" TEXT, ADD COLUMN "packageMemberId" TEXT;
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_parentPackageListingId_fkey" FOREIGN KEY ("parentPackageListingId") REFERENCES "MarketListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketRelease" ADD CONSTRAINT "MarketRelease_parentPackageReleaseId_fkey" FOREIGN KEY ("parentPackageReleaseId") REFERENCES "MarketRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketInstall" ADD CONSTRAINT "MarketInstall_parentPackageInstallId_fkey" FOREIGN KEY ("parentPackageInstallId") REFERENCES "MarketInstall"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "MarketListing_parentPackageListingId_packageMemberId_key" ON "MarketListing"("parentPackageListingId", "packageMemberId");
CREATE UNIQUE INDEX "MarketRelease_parentPackageReleaseId_packageMemberId_key" ON "MarketRelease"("parentPackageReleaseId", "packageMemberId");
CREATE UNIQUE INDEX "MarketInstall_parentPackageInstallId_packageMemberId_key" ON "MarketInstall"("parentPackageInstallId", "packageMemberId");
ALTER TABLE "GithubRegistryResource"
  DROP CONSTRAINT "GithubRegistryResource_listing_kind_check",
  ADD CONSTRAINT "GithubRegistryResource_listing_kind_check" CHECK (
    ("kind" = 'agent' AND "agentListingId" IS NOT NULL AND "listingId" IS NULL)
    OR ("kind" IN ('skill', 'mcp', 'pi-package', 'assistant', 'resource-package') AND "listingId" IS NOT NULL AND "agentListingId" IS NULL)
  );
