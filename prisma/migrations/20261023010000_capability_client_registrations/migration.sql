-- Additive: legacy package registrations keep their original pins and an empty selection list.
ALTER TABLE "PiPackageClientInstallation"
  ALTER COLUMN "marketInstallId" DROP NOT NULL,
  ALTER COLUMN "releaseId" DROP NOT NULL,
  ADD COLUMN "selections" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT "PiPackageClientInstallation_baseline_pair_check"
    CHECK (("marketInstallId" IS NULL) = ("releaseId" IS NULL)),
  ADD CONSTRAINT "PiPackageClientInstallation_selection_shape_check"
    CHECK (jsonb_typeof("selections") = 'array' AND
      ("marketInstallId" IS NOT NULL OR jsonb_array_length("selections") > 0));

-- JSON is the consumer DTO; these normalized references make retention enforceable.
CREATE TABLE "PiPackageClientSelection" (
  "installationId" TEXT NOT NULL,
  "releaseId" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('skill', 'mcp', 'pi-package')),
  CONSTRAINT "PiPackageClientSelection_pkey" PRIMARY KEY ("installationId", "releaseId"),
  CONSTRAINT "PiPackageClientSelection_installationId_fkey" FOREIGN KEY ("installationId")
    REFERENCES "PiPackageClientInstallation"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "PiPackageClientSelection_releaseId_fkey" FOREIGN KEY ("releaseId")
    REFERENCES "MarketRelease"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "PiPackageClientSelection_releaseId_idx" ON "PiPackageClientSelection"("releaseId");

CREATE FUNCTION toolplane_validate_client_registration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  selection jsonb;
  release_checksum text;
  release_kind text;
  install_listing text;
  install_workspace text;
  release_listing text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."workspaceId", NEW."userId", NEW."client") IS DISTINCT FROM
       (OLD."workspaceId", OLD."userId", OLD."client") THEN
      RAISE EXCEPTION 'Client registration owner and client identity are immutable';
    END IF;
    IF (NEW."marketInstallId", NEW."releaseId", NEW."selections") IS DISTINCT FROM
       (OLD."marketInstallId", OLD."releaseId", OLD."selections") AND
       current_setting('toolplane.client_registration_reviewed_update', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'Client registration selection changes require an explicit reviewed update transaction';
    END IF;
  END IF;
  IF NEW."marketInstallId" IS NOT NULL THEN
    SELECT "listingId", "targetWorkspaceId" INTO install_listing, install_workspace
      FROM "MarketInstall" WHERE id = NEW."marketInstallId" FOR SHARE;
    SELECT "listingId" INTO release_listing FROM "MarketRelease" WHERE id = NEW."releaseId" FOR SHARE;
    IF install_listing IS NULL OR release_listing IS NULL OR
       install_listing <> release_listing OR install_workspace <> NEW."workspaceId" THEN
      RAISE EXCEPTION 'Client registration baseline must belong to its workspace and release listing';
    END IF;
  END IF;
  IF jsonb_typeof(NEW."selections") IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Client selections must be an array';
  END IF;
  FOR selection IN SELECT value FROM jsonb_array_elements(NEW."selections") LOOP
    IF jsonb_typeof(selection) IS DISTINCT FROM 'object' OR
       NOT (selection ?& ARRAY['releaseId', 'checksum', 'kind']) OR
       (selection - ARRAY['releaseId', 'checksum', 'kind']) <> '{}'::jsonb OR
       jsonb_typeof(selection->'releaseId') IS DISTINCT FROM 'string' OR
       jsonb_typeof(selection->'checksum') IS DISTINCT FROM 'string' OR
       jsonb_typeof(selection->'kind') IS DISTINCT FROM 'string' OR
       selection->>'kind' NOT IN ('skill', 'mcp', 'pi-package') THEN
      RAISE EXCEPTION 'Client selections contain only releaseId, checksum and supported kind strings';
    END IF;
    SELECT r.checksum, l.kind INTO release_checksum, release_kind
      FROM "MarketRelease" r JOIN "MarketListing" l ON l.id = r."listingId"
      WHERE r.id = selection->>'releaseId' FOR SHARE OF r, l;
    IF release_checksum IS NULL OR release_checksum <> selection->>'checksum' OR
       release_kind <> selection->>'kind' THEN
      RAISE EXCEPTION 'Client selection does not match a retained release identity';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER "PiPackageClientInstallation_validate"
  BEFORE INSERT OR UPDATE ON "PiPackageClientInstallation"
  FOR EACH ROW EXECUTE FUNCTION toolplane_validate_client_registration();

CREATE FUNCTION toolplane_sync_client_selection_references() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."selections" = OLD."selections" THEN RETURN NEW; END IF;
  DELETE FROM "PiPackageClientSelection" WHERE "installationId" = NEW.id;
  INSERT INTO "PiPackageClientSelection" ("installationId", "releaseId", checksum, kind)
    SELECT NEW.id, value->>'releaseId', value->>'checksum', value->>'kind'
    FROM jsonb_array_elements(NEW."selections");
  RETURN NEW;
END $$;
CREATE TRIGGER "PiPackageClientInstallation_sync_selections"
  AFTER INSERT OR UPDATE ON "PiPackageClientInstallation"
  FOR EACH ROW EXECUTE FUNCTION toolplane_sync_client_selection_references();

-- Prevent direct writes from removing references while the JSON still names them.
CREATE FUNCTION toolplane_guard_client_selection_references() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Client selection references are maintained by registration updates only';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PiPackageClientSelection_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "PiPackageClientSelection"
  FOR EACH ROW EXECUTE FUNCTION toolplane_guard_client_selection_references();

CREATE FUNCTION toolplane_guard_selected_release_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW."listingId", NEW.checksum, NEW.version) IS DISTINCT FROM
     (OLD.id, OLD."listingId", OLD.checksum, OLD.version) AND
     EXISTS (SELECT 1 FROM "PiPackageClientSelection" WHERE "releaseId" = OLD.id) THEN
    RAISE EXCEPTION 'Client-referenced release identity and version are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "MarketRelease_client_selection_identity"
  BEFORE UPDATE ON "MarketRelease" FOR EACH ROW
  EXECUTE FUNCTION toolplane_guard_selected_release_identity();

CREATE FUNCTION toolplane_guard_selected_listing_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind AND EXISTS (
    SELECT 1 FROM "PiPackageClientSelection" s JOIN "MarketRelease" r ON r.id = s."releaseId"
      WHERE r."listingId" = OLD.id
  ) THEN RAISE EXCEPTION 'Client-referenced capability kind is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "MarketListing_client_selection_kind"
  BEFORE UPDATE ON "MarketListing" FOR EACH ROW
  EXECUTE FUNCTION toolplane_guard_selected_listing_kind();

-- Environment credentials are private producer-owned records, never artifact data.
-- A composite FK prevents attaching a credential to an Agent in another workspace.
CREATE UNIQUE INDEX "Agent_id_workspaceId_key" ON "Agent"("id", "workspaceId");
CREATE TABLE "AgentEnvironmentCredential" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "name" TEXT NOT NULL CHECK ("name" ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  "encryptedValue" JSONB NOT NULL CHECK (jsonb_typeof("encryptedValue") = 'object'),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentEnvironmentCredential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentEnvironmentCredential_workspaceId_fkey" FOREIGN KEY ("workspaceId")
    REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AgentEnvironmentCredential_agentId_workspaceId_fkey" FOREIGN KEY ("agentId", "workspaceId")
    REFERENCES "Agent"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "AgentEnvironmentCredential_agentId_name_key"
  ON "AgentEnvironmentCredential"("agentId", "name");
CREATE INDEX "AgentEnvironmentCredential_workspaceId_agentId_revokedAt_idx"
  ON "AgentEnvironmentCredential"("workspaceId", "agentId", "revokedAt");

CREATE FUNCTION toolplane_guard_environment_credential() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Environment credentials must be revoked, not deleted; revision references are retained';
  END IF;
  IF (NEW.id, NEW."workspaceId", NEW."agentId", NEW.name, NEW."createdAt") IS DISTINCT FROM
     (OLD.id, OLD."workspaceId", OLD."agentId", OLD.name, OLD."createdAt") THEN
    RAISE EXCEPTION 'Environment credential identity and ownership are immutable';
  END IF;
  IF OLD."revokedAt" IS NOT NULL AND
     (NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" OR
      NEW."encryptedValue" IS DISTINCT FROM OLD."encryptedValue") THEN
    RAISE EXCEPTION 'Revoked environment credentials cannot be restored or rotated';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AgentEnvironmentCredential_retention"
  BEFORE UPDATE OR DELETE ON "AgentEnvironmentCredential"
  FOR EACH ROW EXECUTE FUNCTION toolplane_guard_environment_credential();

-- Revision snapshots retain their source releases independently of installations.
CREATE TABLE "AgentRevisionReleaseReference" (
  "revisionId" TEXT NOT NULL REFERENCES "AgentRevision"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  "releaseId" TEXT NOT NULL REFERENCES "MarketRelease"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  PRIMARY KEY ("revisionId", "releaseId")
);
CREATE INDEX "AgentRevisionReleaseReference_releaseId_idx" ON "AgentRevisionReleaseReference"("releaseId");
CREATE TABLE "ChatAssistantRevisionReleaseReference" (
  "revisionId" TEXT NOT NULL REFERENCES "ChatAssistantRevision"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  "releaseId" TEXT NOT NULL REFERENCES "MarketRelease"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  PRIMARY KEY ("revisionId", "releaseId")
);
CREATE INDEX "ChatAssistantRevisionReleaseReference_releaseId_idx" ON "ChatAssistantRevisionReleaseReference"("releaseId");

CREATE FUNCTION toolplane_retain_revision_releases(revision_id text, snapshot jsonb, is_agent boolean)
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
      CONTINUE; -- Inline prompt snapshots intentionally have no market source.
    END IF;
    IF jsonb_typeof(item->CASE WHEN is_agent THEN 'releaseId' ELSE 'sourceReleaseId' END) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Revision source release identity must be a string';
    END IF;
    release_id := item->>CASE WHEN is_agent THEN 'releaseId' ELSE 'sourceReleaseId' END;
    -- SHARE conflicts with identity updates; the FK also serializes deletion.
    SELECT r.checksum, l.kind INTO release_checksum, release_kind
      FROM "MarketRelease" r JOIN "MarketListing" l ON l.id = r."listingId"
      WHERE r.id = release_id FOR SHARE OF r, l;
    IF release_checksum IS NULL OR release_kind <> 'pi-package' THEN
      RAISE EXCEPTION 'Revision source must reference a retained Pi package release';
    END IF;
    IF is_agent THEN
      IF jsonb_typeof(item->'integrity') IS DISTINCT FROM 'string' OR item->>'integrity' <> release_checksum THEN
        RAISE EXCEPTION 'Agent revision package integrity must match its release checksum';
      END IF;
      INSERT INTO "AgentRevisionReleaseReference" VALUES (revision_id, release_id) ON CONFLICT DO NOTHING;
    ELSE
      -- Prompt checksum identifies Markdown bytes, not the enclosing package.
      INSERT INTO "ChatAssistantRevisionReleaseReference" VALUES (revision_id, release_id) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION toolplane_sync_revision_release_references() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM toolplane_retain_revision_releases(NEW.id, NEW.config, TG_TABLE_NAME = 'AgentRevision');
  RETURN NEW;
END $$;
CREATE TRIGGER "AgentRevision_retain_releases" AFTER INSERT ON "AgentRevision"
  FOR EACH ROW EXECUTE FUNCTION toolplane_sync_revision_release_references();
CREATE TRIGGER "ChatAssistantRevision_retain_releases" AFTER INSERT ON "ChatAssistantRevision"
  FOR EACH ROW EXECUTE FUNCTION toolplane_sync_revision_release_references();

-- Existing immutable revisions receive exactly the same validation and retention.
DO $$
DECLARE revision record;
BEGIN
  FOR revision IN SELECT id, config FROM "AgentRevision" LOOP
    PERFORM toolplane_retain_revision_releases(revision.id, revision.config, true);
  END LOOP;
  FOR revision IN SELECT id, config FROM "ChatAssistantRevision" LOOP
    PERFORM toolplane_retain_revision_releases(revision.id, revision.config, false);
  END LOOP;
END $$;
CREATE TRIGGER "AgentRevisionReleaseReference_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AgentRevisionReleaseReference"
  FOR EACH ROW EXECUTE FUNCTION toolplane_guard_client_selection_references();
CREATE TRIGGER "ChatAssistantRevisionReleaseReference_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "ChatAssistantRevisionReleaseReference"
  FOR EACH ROW EXECUTE FUNCTION toolplane_guard_client_selection_references();

CREATE OR REPLACE FUNCTION toolplane_guard_selected_release_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW."listingId", NEW.checksum, NEW.version) IS DISTINCT FROM
     (OLD.id, OLD."listingId", OLD.checksum, OLD.version) AND (
       EXISTS (SELECT 1 FROM "PiPackageClientSelection" WHERE "releaseId" = OLD.id) OR
       EXISTS (SELECT 1 FROM "AgentRevisionReleaseReference" WHERE "releaseId" = OLD.id) OR
       EXISTS (SELECT 1 FROM "ChatAssistantRevisionReleaseReference" WHERE "releaseId" = OLD.id)
     ) THEN
    RAISE EXCEPTION 'Referenced release identity and version are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION toolplane_guard_selected_listing_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind AND EXISTS (
    SELECT 1 FROM "MarketRelease" r WHERE r."listingId" = OLD.id AND (
      EXISTS (SELECT 1 FROM "PiPackageClientSelection" s WHERE s."releaseId" = r.id) OR
      EXISTS (SELECT 1 FROM "AgentRevisionReleaseReference" a WHERE a."releaseId" = r.id) OR
      EXISTS (SELECT 1 FROM "ChatAssistantRevisionReleaseReference" c WHERE c."releaseId" = r.id)
    )
  ) THEN RAISE EXCEPTION 'Referenced capability kind is immutable'; END IF;
  RETURN NEW;
END $$;

-- Never infer access from an old broad Agent/deployment binding.
ALTER TABLE "AgentServer" ADD COLUMN "allowedToolNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
