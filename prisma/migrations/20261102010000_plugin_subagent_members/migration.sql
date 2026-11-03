-- Add provenance only; historical definitions, revisions and checksums remain unchanged.
CREATE TABLE "PluginSubagentMember" (
  "versionId" TEXT PRIMARY KEY REFERENCES "WorkspaceSubagentVersion"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  "installId" TEXT NOT NULL REFERENCES "MarketInstall"("id") ON DELETE NO ACTION ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  "releaseId" TEXT NOT NULL REFERENCES "MarketRelease"("id") ON DELETE NO ACTION ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  "path" TEXT NOT NULL,
  UNIQUE ("installId", "releaseId", "path")
);
CREATE INDEX "PluginSubagentMember_releaseId_idx" ON "PluginSubagentMember"("releaseId");
CREATE FUNCTION toolplane_plugin_subagent_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM "WorkspaceSubagentVersion" WHERE id=OLD."versionId") THEN RETURN OLD; END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Plugin subagent provenance is immutable'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "WorkspaceSubagentVersion" v
    JOIN "WorkspaceSubagent" s ON s.id=v."subagentId"
    JOIN "MarketInstall" i ON i."targetWorkspaceId"=s."workspaceId"
    JOIN "MarketRelease" r ON r.id=NEW."releaseId" AND r."listingId"=i."listingId"
    WHERE v.id=NEW."versionId" AND i.id=NEW."installId" AND i."currentReleaseId"=r.id
      AND COALESCE(r.manifest#>'{package,resources,subagents}', '[]'::jsonb) ? NEW.path
  ) THEN RAISE EXCEPTION 'Plugin subagent member source mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PluginSubagentMember_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PluginSubagentMember"
  FOR EACH ROW EXECUTE FUNCTION toolplane_plugin_subagent_member_guard();
