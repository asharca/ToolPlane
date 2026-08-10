ALTER TABLE "AgentEndpoint"
ADD COLUMN "maxRuntimes" INTEGER NOT NULL DEFAULT 100;

CREATE TABLE "AgentApiMaintenanceLease" (
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentApiMaintenanceLease_pkey" PRIMARY KEY ("name")
);

CREATE INDEX "AgentEndpointRuntime_revisionId_idx"
ON "AgentEndpointRuntime"("revisionId");
CREATE INDEX "AgentEndpointRuntime_status_lastUsedAt_idx"
ON "AgentEndpointRuntime"("status", "lastUsedAt");
CREATE INDEX "AgentPublicConversation_endpointId_createdAt_idx"
ON "AgentPublicConversation"("endpointId", "createdAt");
CREATE INDEX "AgentPublicConversation_clientId_idx"
ON "AgentPublicConversation"("clientId");
CREATE INDEX "AgentPublicConversation_revisionId_idx"
ON "AgentPublicConversation"("revisionId");
CREATE INDEX "AgentRun_clientId_status_createdAt_idx"
ON "AgentRun"("clientId", "status", "createdAt");
CREATE INDEX "AgentRun_revisionId_idx"
ON "AgentRun"("revisionId");
CREATE INDEX "AgentRun_runtimeAllocationId_idx"
ON "AgentRun"("runtimeAllocationId");

-- Keep the public authorization graph consistent even if a future write path
-- bypasses the current application-level workspace/Endpoint predicates.
CREATE FUNCTION "validate_agent_endpoint_consistency"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'AgentEndpoint' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "Agent" a
      WHERE a."id" = NEW."sourceAgentId" AND a."workspaceId" = NEW."workspaceId"
    ) THEN
      RAISE EXCEPTION 'Agent Endpoint source Agent belongs to another workspace'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."currentRevisionId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "AgentEndpointRevision" r
      WHERE r."id" = NEW."currentRevisionId" AND r."endpointId" = NEW."id"
    ) THEN
      RAISE EXCEPTION 'Agent Endpoint current revision belongs to another Endpoint'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'AgentEndpointRuntime' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "AgentEndpointRevision" r
      WHERE r."id" = NEW."revisionId" AND r."endpointId" = NEW."endpointId"
    ) THEN
      RAISE EXCEPTION 'Agent Endpoint runtime revision belongs to another Endpoint'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'AgentPublicConversation' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "AgentEndpointRevision" r, "AgentApiClient" c, "AgentEndpointRuntime" ar
      WHERE r."id" = NEW."revisionId" AND r."endpointId" = NEW."endpointId"
        AND c."id" = NEW."clientId" AND c."endpointId" = NEW."endpointId"
        AND ar."id" = NEW."runtimeAllocationId"
        AND ar."endpointId" = NEW."endpointId" AND ar."revisionId" = NEW."revisionId"
    ) THEN
      RAISE EXCEPTION 'Agent public conversation contains cross-Endpoint references'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'AgentRun' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "AgentEndpointRevision" r, "AgentApiClient" c
      WHERE r."id" = NEW."revisionId" AND r."endpointId" = NEW."endpointId"
        AND c."id" = NEW."clientId" AND c."endpointId" = NEW."endpointId"
    ) THEN
      RAISE EXCEPTION 'Agent run revision or client belongs to another Endpoint'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."runtimeAllocationId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "AgentEndpointRuntime" ar
      WHERE ar."id" = NEW."runtimeAllocationId"
        AND ar."endpointId" = NEW."endpointId" AND ar."revisionId" = NEW."revisionId"
    ) THEN
      RAISE EXCEPTION 'Agent run runtime belongs to another Endpoint or revision'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."publicConversationId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "AgentPublicConversation" pc
      WHERE pc."id" = NEW."publicConversationId"
        AND pc."endpointId" = NEW."endpointId"
        AND pc."revisionId" = NEW."revisionId"
        AND pc."clientId" = NEW."clientId"
        AND pc."subjectHash" = NEW."subjectHash"
        AND (NEW."runtimeAllocationId" IS NULL OR pc."runtimeAllocationId" = NEW."runtimeAllocationId")
    ) THEN
      RAISE EXCEPTION 'Agent run conversation contains cross-Endpoint references'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AgentEndpoint_consistency_trigger"
BEFORE INSERT OR UPDATE ON "AgentEndpoint"
FOR EACH ROW EXECUTE FUNCTION "validate_agent_endpoint_consistency"();
CREATE TRIGGER "AgentEndpointRuntime_consistency_trigger"
BEFORE INSERT OR UPDATE ON "AgentEndpointRuntime"
FOR EACH ROW EXECUTE FUNCTION "validate_agent_endpoint_consistency"();
CREATE TRIGGER "AgentPublicConversation_consistency_trigger"
BEFORE INSERT OR UPDATE ON "AgentPublicConversation"
FOR EACH ROW EXECUTE FUNCTION "validate_agent_endpoint_consistency"();
CREATE TRIGGER "AgentRun_consistency_trigger"
BEFORE INSERT OR UPDATE ON "AgentRun"
FOR EACH ROW EXECUTE FUNCTION "validate_agent_endpoint_consistency"();
