ALTER TABLE "Agent" ADD COLUMN "capabilityImport" JSONB;
CREATE TABLE "WorkspaceSubagent" (
 "id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "name" TEXT NOT NULL, "description" TEXT, "currentVersion" INTEGER NOT NULL DEFAULT 1,
 "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("workspaceId", "id")
);
CREATE TABLE "WorkspaceSubagentVersion" (
 "id" TEXT PRIMARY KEY, "subagentId" TEXT NOT NULL REFERENCES "WorkspaceSubagent"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "version" INTEGER NOT NULL, "definition" JSONB NOT NULL, "checksum" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("subagentId", "version"), UNIQUE ("subagentId", "id")
);
CREATE TABLE "AgentSubagentBinding" (
 "agentId" TEXT NOT NULL REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "subagentId" TEXT NOT NULL REFERENCES "WorkspaceSubagent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "versionId" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
 PRIMARY KEY ("agentId", "subagentId"),
 FOREIGN KEY ("subagentId", "versionId") REFERENCES "WorkspaceSubagentVersion"("subagentId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE FUNCTION toolplane_subagent_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM "WorkspaceSubagent" WHERE id=OLD."subagentId") THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Subagent versions are immutable';
END $$;
CREATE TRIGGER "WorkspaceSubagentVersion_immutable" BEFORE UPDATE OR DELETE ON "WorkspaceSubagentVersion"
 FOR EACH ROW EXECUTE FUNCTION toolplane_subagent_version_immutable();
CREATE FUNCTION toolplane_subagent_binding_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "Agent" a JOIN "WorkspaceSubagent" s ON s."workspaceId"=a."workspaceId" WHERE a.id=NEW."agentId" AND s.id=NEW."subagentId") THEN
 RAISE EXCEPTION 'Subagent binding workspace mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "AgentSubagentBinding_workspace" BEFORE INSERT OR UPDATE ON "AgentSubagentBinding"
 FOR EACH ROW EXECUTE FUNCTION toolplane_subagent_binding_workspace();
-- Existing revisions remain byte-for-byte unchanged. New optional subagent pins
-- are validated at insertion and retained independently of mutable draft bindings.
CREATE TABLE "AgentRevisionSubagentReference" (
 "revisionId" TEXT NOT NULL REFERENCES "AgentRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "subagentId" TEXT NOT NULL,
 "versionId" TEXT NOT NULL,
 PRIMARY KEY ("revisionId", "subagentId"),
 FOREIGN KEY ("subagentId", "versionId") REFERENCES "WorkspaceSubagentVersion"("subagentId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE FUNCTION toolplane_revision_subagent_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pin JSONB;
BEGIN
 FOR pin IN SELECT * FROM jsonb_array_elements(COALESCE(NEW.config->'subagents','[]'::jsonb)) LOOP
 IF NOT EXISTS (
 SELECT 1 FROM "WorkspaceSubagentVersion" v JOIN "WorkspaceSubagent" s ON s.id=v."subagentId" JOIN "Agent" a ON a."workspaceId"=s."workspaceId"
 WHERE a.id=NEW."agentId" AND v.id=pin->>'versionId' AND s.id=pin->>'subagentId' AND v.checksum=pin->>'checksum'
 ) THEN RAISE EXCEPTION 'Invalid subagent revision pin'; END IF;
 INSERT INTO "AgentRevisionSubagentReference" VALUES (NEW.id,pin->>'subagentId',pin->>'versionId');
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER "AgentRevision_subagent_references" AFTER INSERT ON "AgentRevision"
 FOR EACH ROW EXECUTE FUNCTION toolplane_revision_subagent_references();

CREATE FUNCTION toolplane_subagent_version_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_version INTEGER;
BEGIN
 PERFORM 1 FROM "WorkspaceSubagent" WHERE id=NEW."subagentId" FOR UPDATE;
 SELECT COALESCE(MAX(version),0) INTO previous_version FROM "WorkspaceSubagentVersion" WHERE "subagentId"=NEW."subagentId";
 IF NEW.version <> previous_version+1 THEN RAISE EXCEPTION 'Subagent versions must be consecutive'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "WorkspaceSubagentVersion_sequence" BEFORE INSERT ON "WorkspaceSubagentVersion"
 FOR EACH ROW EXECUTE FUNCTION toolplane_subagent_version_sequence();
CREATE FUNCTION toolplane_subagent_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.id,OLD."workspaceId",OLD."createdAt") IS DISTINCT FROM (NEW.id,NEW."workspaceId",NEW."createdAt") OR NEW."currentVersion" < OLD."currentVersion" THEN
 RAISE EXCEPTION 'Subagent owner and version history are retained'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "WorkspaceSubagent_owner" BEFORE UPDATE ON "WorkspaceSubagent"
 FOR EACH ROW EXECUTE FUNCTION toolplane_subagent_owner_guard();
CREATE FUNCTION toolplane_subagent_current_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM "WorkspaceSubagent" s WHERE s.id=NEW.id AND NOT EXISTS(SELECT 1 FROM "WorkspaceSubagentVersion" v WHERE v."subagentId"=s.id AND v.version=s."currentVersion")) THEN
 RAISE EXCEPTION 'Subagent current version must exist'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER "WorkspaceSubagent_current_version" AFTER INSERT OR UPDATE ON "WorkspaceSubagent"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION toolplane_subagent_current_version();
