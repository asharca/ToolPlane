BEGIN;

-- Detach Pi members first: their immutable releases and workspace/session pins survive.
UPDATE "MarketInstall" i SET "parentPackageInstallId" = NULL, "packageMemberId" = NULL FROM "MarketListing" l WHERE i."listingId" = l.id AND l.kind = 'pi-package';
UPDATE "MarketListing" SET "parentPackageListingId" = NULL, "packageMemberId" = NULL WHERE kind = 'pi-package';
UPDATE "MarketRelease" r SET "parentPackageReleaseId" = NULL, "packageMemberId" = NULL FROM "MarketListing" l WHERE r."listingId" = l.id AND l.kind = 'pi-package';

-- chat/service.ts copies template prompts/model settings into ChatAssistant on import;
-- published ChatAssistantRevision.config stores the complete execution configuration.
-- Legacy currentRevisionVersion=0 rows are drafts and historical threads stay unresolved:
-- do not fabricate authorized revisions from mutable state. Release-reference triggers
-- only accept Pi releases (including prompt provenance). Keep every such reference;
-- no reference is deleted and no revision JSON is rewritten during this cutover.
-- Unexpected retained non-Pi artifacts are kept as removed history, never discoverable.
DELETE FROM "PiPackageClientInstallation";
DELETE FROM "MarketInstall" i USING "MarketListing" l WHERE i."listingId" = l.id AND l.kind <> 'pi-package'
 AND NOT EXISTS (SELECT 1 FROM "PiSessionPackage" p WHERE p."marketInstallId" = i.id)
 AND NOT EXISTS (SELECT 1 FROM "AgentPiPackage" p WHERE p."marketInstallId" = i.id);
UPDATE "ChatAssistant" SET "marketTemplateReleaseId" = NULL;
DELETE FROM "GithubRegistryResource" WHERE kind <> 'pi-package';
-- Remove parent/member edges on retired rows before deleting composite parents.
UPDATE "MarketListing" SET "parentPackageListingId" = NULL, "packageMemberId" = NULL;
UPDATE "MarketRelease" SET "parentPackageReleaseId" = NULL, "packageMemberId" = NULL;
DELETE FROM "MarketRelease" r USING "MarketListing" l WHERE r."listingId" = l.id AND l.kind <> 'pi-package'
 AND NOT EXISTS (SELECT 1 FROM "AgentRevisionReleaseReference" p WHERE p."releaseId" = r.id)
 AND NOT EXISTS (SELECT 1 FROM "ChatAssistantRevisionReleaseReference" p WHERE p."releaseId" = r.id)
 AND NOT EXISTS (SELECT 1 FROM "PiSessionPackage" p WHERE p."releaseId" = r.id)
 AND NOT EXISTS (SELECT 1 FROM "MarketInstall" p WHERE p."currentReleaseId" = r.id OR p."requestedReleaseId" = r.id)
 AND NOT EXISTS (SELECT 1 FROM "AgentPiPackage" p WHERE p."releaseId" = r.id);
DELETE FROM "MarketListing" l WHERE l.kind <> 'pi-package'
 AND NOT EXISTS (SELECT 1 FROM "MarketRelease" r WHERE r."listingId" = l.id)
 AND NOT EXISTS (SELECT 1 FROM "MarketInstall" i WHERE i."listingId" = l.id);
UPDATE "MarketListing" SET status = CASE WHEN kind <> 'pi-package' THEN 'removed' WHEN status = 'disabled' THEN 'withdrawn' WHEN status = 'published' THEN 'published' ELSE 'removed' END;
UPDATE "MarketRelease" SET "reviewStatus" = 'revoked' WHERE "reviewStatus" <> 'approved';
-- Flush retained Pi snapshot constraint triggers before changing their tables.
SET CONSTRAINTS ALL IMMEDIATE;

-- DropForeignKey
ALTER TABLE "AgentInstall" DROP CONSTRAINT "AgentInstall_agentId_fkey";

-- DropForeignKey
ALTER TABLE "AgentInstall" DROP CONSTRAINT "AgentInstall_installedById_fkey";

-- DropForeignKey
ALTER TABLE "AgentInstall" DROP CONSTRAINT "AgentInstall_releaseId_fkey";

-- DropForeignKey
ALTER TABLE "AgentInstall" DROP CONSTRAINT "AgentInstall_targetWorkspaceId_fkey";

-- DropForeignKey
ALTER TABLE "AgentListing" DROP CONSTRAINT "AgentListing_latestReleaseId_fkey";

-- DropForeignKey
ALTER TABLE "AgentListing" DROP CONSTRAINT "AgentListing_pendingReleaseId_fkey";

-- DropForeignKey
ALTER TABLE "AgentListing" DROP CONSTRAINT "AgentListing_publishedById_fkey";

-- DropForeignKey
ALTER TABLE "AgentListing" DROP CONSTRAINT "AgentListing_publisherWorkspaceId_fkey";

-- DropForeignKey
ALTER TABLE "AgentListing" DROP CONSTRAINT "AgentListing_sourceAgentId_fkey";

-- DropForeignKey
ALTER TABLE "AgentRelease" DROP CONSTRAINT "AgentRelease_listingId_fkey";

-- DropForeignKey
ALTER TABLE "AgentRelease" DROP CONSTRAINT "AgentRelease_reviewedById_fkey";

-- DropForeignKey
ALTER TABLE "ChatAssistant" DROP CONSTRAINT "ChatAssistant_marketTemplateReleaseId_fkey";

-- DropForeignKey
ALTER TABLE "GithubRegistryResource" DROP CONSTRAINT "GithubRegistryResource_agentListingId_fkey";

-- DropForeignKey
ALTER TABLE "GithubRegistryVersion" DROP CONSTRAINT "GithubRegistryVersion_agentReleaseId_fkey";

-- DropForeignKey
ALTER TABLE "MarketInstall" DROP CONSTRAINT "MarketInstall_agentId_fkey";

-- DropForeignKey
ALTER TABLE "MarketInstall" DROP CONSTRAINT "MarketInstall_deploymentId_fkey";

-- DropForeignKey
ALTER TABLE "MarketInstall" DROP CONSTRAINT "MarketInstall_ignoredReleaseId_fkey";

-- DropForeignKey
ALTER TABLE "MarketInstall" DROP CONSTRAINT "MarketInstall_installedSkillId_fkey";

-- DropForeignKey
ALTER TABLE "MarketInstall" DROP CONSTRAINT "MarketInstall_parentPackageInstallId_fkey";

-- DropForeignKey
ALTER TABLE "MarketInstall" DROP CONSTRAINT "MarketInstall_requestedReleaseId_fkey";

-- DropForeignKey
ALTER TABLE "MarketInstall" DROP CONSTRAINT "MarketInstall_toolkitId_fkey";

-- DropForeignKey
ALTER TABLE "MarketListing" DROP CONSTRAINT "MarketListing_parentPackageListingId_fkey";

-- DropForeignKey
ALTER TABLE "MarketListing" DROP CONSTRAINT "MarketListing_pendingReleaseId_fkey";

-- DropForeignKey
ALTER TABLE "MarketListing" DROP CONSTRAINT "MarketListing_sourceAgentId_fkey";

-- DropForeignKey
ALTER TABLE "MarketListing" DROP CONSTRAINT "MarketListing_sourceChatAssistantId_fkey";

-- DropForeignKey
ALTER TABLE "MarketListing" DROP CONSTRAINT "MarketListing_sourceDeploymentId_fkey";

-- DropForeignKey
ALTER TABLE "MarketListing" DROP CONSTRAINT "MarketListing_sourceInstalledSkillId_fkey";

-- DropForeignKey
ALTER TABLE "MarketListing" DROP CONSTRAINT "MarketListing_sourceServerId_fkey";

-- DropForeignKey
ALTER TABLE "MarketListing" DROP CONSTRAINT "MarketListing_sourceSkillId_fkey";

-- DropForeignKey
ALTER TABLE "MarketListing" DROP CONSTRAINT "MarketListing_sourceToolkitId_fkey";

-- DropForeignKey
ALTER TABLE "MarketRelease" DROP CONSTRAINT "MarketRelease_parentPackageReleaseId_fkey";

-- DropForeignKey
ALTER TABLE "PiPackageClientInstallation" DROP CONSTRAINT "PiPackageClientInstallation_marketInstallId_fkey";

-- DropForeignKey
ALTER TABLE "PiPackageClientInstallation" DROP CONSTRAINT "PiPackageClientInstallation_releaseId_fkey";

-- DropForeignKey
ALTER TABLE "PiPackageClientInstallation" DROP CONSTRAINT "PiPackageClientInstallation_userId_fkey";

-- DropForeignKey
ALTER TABLE "PiPackageClientInstallation" DROP CONSTRAINT "PiPackageClientInstallation_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "PiPackageClientSelection" DROP CONSTRAINT "PiPackageClientSelection_installationId_fkey";

-- DropForeignKey
ALTER TABLE "PiPackageClientSelection" DROP CONSTRAINT "PiPackageClientSelection_releaseId_fkey";

-- DropForeignKey
ALTER TABLE "PiPackageSource" DROP CONSTRAINT "PiPackageSource_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "PiPackageTracking" DROP CONSTRAINT "PiPackageTracking_listingId_fkey";

-- DropForeignKey
ALTER TABLE "PiPackageTracking" DROP CONSTRAINT "PiPackageTracking_sourceId_fkey";

-- DropForeignKey
ALTER TABLE "PiPackageTracking" DROP CONSTRAINT "PiPackageTracking_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "_AgentListingCategories" DROP CONSTRAINT "_AgentListingCategories_A_fkey";

-- DropForeignKey
ALTER TABLE "_AgentListingCategories" DROP CONSTRAINT "_AgentListingCategories_B_fkey";

-- DropForeignKey
ALTER TABLE "_MarketListingCategories" DROP CONSTRAINT "_MarketListingCategories_A_fkey";

-- DropForeignKey
ALTER TABLE "_MarketListingCategories" DROP CONSTRAINT "_MarketListingCategories_B_fkey";

-- DropIndex
DROP INDEX "ChatAssistant_marketTemplateReleaseId_idx";

-- DropIndex
DROP INDEX "GithubRegistryResource_agentListingId_key";

-- DropIndex
DROP INDEX "GithubRegistryVersion_agentReleaseId_key";

-- DropIndex
DROP INDEX "MarketInstall_agentId_key";

-- DropIndex
DROP INDEX "MarketInstall_deploymentId_key";

-- DropIndex
DROP INDEX "MarketInstall_installedSkillId_key";

-- DropIndex
DROP INDEX "MarketInstall_parentPackageInstallId_packageMemberId_key";

-- DropIndex
DROP INDEX "MarketInstall_requestedReleaseId_createdAt_idx";

-- DropIndex
DROP INDEX "MarketInstall_toolkitId_key";

-- DropIndex
DROP INDEX "MarketListing_kind_status_isFeatured_installCount_published_idx";

-- DropIndex
DROP INDEX "MarketListing_parentPackageListingId_packageMemberId_key";

-- DropIndex
DROP INDEX "MarketListing_pendingReleaseId_key";

-- DropIndex
DROP INDEX "MarketListing_pendingReleaseId_updatedAt_idx";

-- DropIndex
DROP INDEX "MarketListing_sourceAgentId_key";

-- DropIndex
DROP INDEX "MarketListing_sourceChatAssistantId_key";

-- DropIndex
DROP INDEX "MarketListing_sourceDeploymentId_key";

-- DropIndex
DROP INDEX "MarketListing_sourceInstalledSkillId_key";

-- DropIndex
DROP INDEX "MarketListing_sourceServerId_key";

-- DropIndex
DROP INDEX "MarketListing_sourceSkillId_key";

-- DropIndex
DROP INDEX "MarketListing_sourceToolkitId_key";

-- DropIndex
DROP INDEX "MarketRelease_parentPackageReleaseId_packageMemberId_key";

-- AlterTable
ALTER TABLE "AgentPiPackage" ADD COLUMN     "syncError" TEXT,
ADD COLUMN     "syncRequestedById" TEXT,
ADD COLUMN     "syncStatus" TEXT NOT NULL DEFAULT 'synced',
ADD COLUMN     "targetReleaseId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "ChatAssistant" DROP COLUMN "marketTemplateReleaseId";

-- AlterTable
ALTER TABLE "GithubRegistryResource" DROP COLUMN "agentListingId";

-- AlterTable
ALTER TABLE "GithubRegistryVersion" DROP COLUMN "agentReleaseId";

-- AlterTable
ALTER TABLE "GithubResourceRegistry" ADD COLUMN     "official" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "workspaceId" DROP NOT NULL,
ALTER COLUMN "createdById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "MarketInstall" DROP COLUMN "agentId",
DROP COLUMN "deploymentId",
DROP COLUMN "ignoredReleaseId",
DROP COLUMN "installedSkillId",
DROP COLUMN "packageMemberId",
DROP COLUMN "parentPackageInstallId",
DROP COLUMN "requestedReleaseId",
DROP COLUMN "requirements",
DROP COLUMN "toolkitId",
DROP COLUMN "updatePolicy";

-- AlterTable
ALTER TABLE "MarketListing" DROP COLUMN "curated",
DROP COLUMN "isFeatured",
DROP COLUMN "packageMemberId",
DROP COLUMN "parentPackageListingId",
DROP COLUMN "pendingReleaseId",
DROP COLUMN "sourceAgentId",
DROP COLUMN "sourceChatAssistantId",
DROP COLUMN "sourceDeploymentId",
DROP COLUMN "sourceInstalledSkillId",
DROP COLUMN "sourceServerId",
DROP COLUMN "sourceSkillId",
DROP COLUMN "sourceToolkitId",
ALTER COLUMN "status" SET DEFAULT 'published';

-- AlterTable
ALTER TABLE "MarketRelease" DROP COLUMN "packageMemberId",
DROP COLUMN "parentPackageReleaseId",
ALTER COLUMN "reviewStatus" SET DEFAULT 'approved';

-- DropTable
DROP TABLE "AgentInstall";

-- DropTable
DROP TABLE "AgentListing";

-- DropTable
DROP TABLE "AgentRelease";

-- DropTable
DROP TABLE "PiPackageClientInstallation";

-- DropTable
DROP TABLE "PiPackageClientSelection";

-- DropTable
DROP TABLE "PiPackageSource";

-- DropTable
DROP TABLE "PiPackageTracking";

-- DropTable
DROP TABLE "_AgentListingCategories";

-- DropTable
DROP TABLE "_MarketListingCategories";

-- CreateIndex
CREATE INDEX "MarketListing_kind_status_installCount_publishedAt_idx" ON "MarketListing"("kind", "status", "installCount", "publishedAt");

-- AddForeignKey
ALTER TABLE "AgentPiPackage" ADD CONSTRAINT "AgentPiPackage_targetReleaseId_fkey" FOREIGN KEY ("targetReleaseId") REFERENCES "MarketRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPiPackage" ADD CONSTRAINT "AgentPiPackage_syncRequestedById_fkey" FOREIGN KEY ("syncRequestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Revision provenance must name an install of this release in the Agent's workspace.
CREATE OR REPLACE FUNCTION toolplane_retain_revision_releases(revision_id text, snapshot jsonb, is_agent boolean)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  item jsonb;
  items jsonb;
  release_id text;
  release_checksum text;
  release_kind text;
BEGIN
  items := COALESCE(snapshot->CASE WHEN is_agent THEN 'packages' ELSE 'promptTemplates' END, '[]'::jsonb);
  IF jsonb_typeof(items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Revision release sources must be an array';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(items) LOOP
    IF NOT is_agent AND (item->'sourceReleaseId' IS NULL OR item->'sourceReleaseId' = 'null'::jsonb) THEN
      CONTINUE;
    END IF;
    IF jsonb_typeof(item->CASE WHEN is_agent THEN 'releaseId' ELSE 'sourceReleaseId' END) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Revision source release identity must be a string';
    END IF;
    release_id := item->>CASE WHEN is_agent THEN 'releaseId' ELSE 'sourceReleaseId' END;
    SELECT r.checksum, l.kind INTO release_checksum, release_kind
      FROM "MarketRelease" r JOIN "MarketListing" l ON l.id = r."listingId"
      WHERE r.id = release_id AND r."reviewStatus" = 'approved' AND l.status IN ('published', 'removed')
      FOR SHARE OF r, l;
    IF release_checksum IS NULL OR release_kind <> 'pi-package' THEN
      RAISE EXCEPTION 'Revision source must reference an executable Pi package release';
    END IF;
    IF is_agent THEN
      IF jsonb_typeof(item->'integrity') IS DISTINCT FROM 'string' OR item->>'integrity' <> release_checksum THEN
        RAISE EXCEPTION 'Agent revision package integrity must match its release checksum';
      END IF;
      PERFORM i.id FROM "MarketInstall" i
        JOIN "MarketRelease" r ON r.id = release_id AND r."listingId" = i."listingId"
        JOIN "AgentRevision" v ON v.id = revision_id
        JOIN "Agent" a ON a.id = v."agentId" AND a."workspaceId" = i."targetWorkspaceId"
        WHERE i.id = item->>'marketInstallId' AND i.status IN ('ready', 'uninstalled')
        FOR SHARE OF i;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Agent revision package must reference its workspace install';
      END IF;
      INSERT INTO "AgentRevisionReleaseReference" VALUES (revision_id, release_id) ON CONFLICT DO NOTHING;
    ELSE
      INSERT INTO "ChatAssistantRevisionReleaseReference" VALUES (revision_id, release_id) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;

-- Replace release identity guards before dropping their retired client tables is observed.
CREATE OR REPLACE FUNCTION toolplane_guard_selected_release_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id, NEW."listingId", NEW.checksum, NEW.version) IS DISTINCT FROM (OLD.id, OLD."listingId", OLD.checksum, OLD.version) AND (
 EXISTS (SELECT 1 FROM "AgentRevisionReleaseReference" WHERE "releaseId" = OLD.id) OR
 EXISTS (SELECT 1 FROM "ChatAssistantRevisionReleaseReference" WHERE "releaseId" = OLD.id)) THEN
 RAISE EXCEPTION 'Referenced release identity and version are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION toolplane_guard_selected_listing_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind IS DISTINCT FROM OLD.kind AND EXISTS (SELECT 1 FROM "MarketRelease" r WHERE r."listingId" = OLD.id AND (
 EXISTS (SELECT 1 FROM "AgentRevisionReleaseReference" WHERE "releaseId" = r.id) OR
 EXISTS (SELECT 1 FROM "ChatAssistantRevisionReleaseReference" WHERE "releaseId" = r.id))) THEN
 RAISE EXCEPTION 'Referenced listing kind is immutable'; END IF;
 RETURN NEW;
END $$;
DROP FUNCTION toolplane_validate_client_registration();
DROP FUNCTION toolplane_sync_client_selection_references();
DROP FUNCTION toolplane_guard_client_config_version();
CREATE UNIQUE INDEX "GithubResourceRegistry_official_repository_branch_key" ON "GithubResourceRegistry" (repository, branch) WHERE "workspaceId" IS NULL;
ALTER TABLE "GithubResourceRegistry" ADD CONSTRAINT "GithubResourceRegistry_scope" CHECK (official = ("workspaceId" IS NULL));
ALTER TABLE "GithubRegistryResource" ADD CONSTRAINT "GithubRegistryResource_pi_only" CHECK (kind = 'pi-package');
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_plugin_status" CHECK (status IN ('published', 'withdrawn', 'removed'));
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_active_pi_only" CHECK (kind = 'pi-package' OR status = 'removed');
ALTER TABLE "MarketRelease" ADD CONSTRAINT "MarketRelease_plugin_review" CHECK ("reviewStatus" IN ('approved', 'revoked'));
ALTER TABLE "AgentPiPackage" ADD CONSTRAINT "AgentPiPackage_sync_status" CHECK ("syncStatus" IN ('synced', 'pending', 'review_required', 'failed'));
COMMIT;
