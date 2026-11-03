-- MCP grants follow the live catalog by default; tool drift no longer pauses tools for review.
CREATE TYPE "McpToolSelection" AS ENUM ('all', 'selected');

ALTER TABLE "AgentServer" ADD COLUMN "toolSelection" "McpToolSelection" NOT NULL DEFAULT 'all';
ALTER TABLE "ChatAssistantMcpGrant" ADD COLUMN "toolSelection" "McpToolSelection" NOT NULL DEFAULT 'all';

-- An explicit list that omits some catalog tools stays an explicit subset;
-- empty or complete lists follow the catalog from now on.
CREATE FUNCTION pg_temp.mcp_catalog_names(cfg jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(array_agg(DISTINCT tool->>'name' ORDER BY tool->>'name'), ARRAY[]::text[])
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(cfg->'toolCatalog') = 'array' THEN cfg->'toolCatalog' ELSE '[]'::jsonb END
  ) AS tool
  WHERE jsonb_typeof(tool->'name') = 'string' AND tool->>'name' <> ''
$$;

UPDATE "AgentServer" s SET "toolSelection" = 'selected'
FROM "Deployment" d
WHERE d.id = s."deploymentId"
  AND cardinality(s."allowedToolNames") > 0
  AND NOT (pg_temp.mcp_catalog_names(d."installCfg"::jsonb) <@ s."allowedToolNames");
UPDATE "AgentServer" s SET "allowedToolNames" = pg_temp.mcp_catalog_names(d."installCfg"::jsonb)
FROM "Deployment" d
WHERE d.id = s."deploymentId" AND s."toolSelection" = 'all';

UPDATE "ChatAssistantMcpGrant" g SET "toolSelection" = 'selected'
FROM "Deployment" d
WHERE d.id = g."deploymentId"
  AND cardinality(g."allowedToolNames") > 0
  AND NOT (pg_temp.mcp_catalog_names(d."installCfg"::jsonb) <@ g."allowedToolNames");
UPDATE "ChatAssistantMcpGrant" g SET "allowedToolNames" = pg_temp.mcp_catalog_names(d."installCfg"::jsonb)
FROM "Deployment" d
WHERE d.id = g."deploymentId" AND g."toolSelection" = 'all';

ALTER TABLE "AgentServer" DROP COLUMN "approvedToolSignatures", DROP COLUMN "pendingToolChanges";
ALTER TABLE "ChatAssistantMcpGrant" DROP COLUMN "approvedToolSignatures", DROP COLUMN "pendingToolChanges";

-- Sessions may move forward to another revision of the same owner in place.
-- Owner changes and unresolved historical sessions stay immutable.
CREATE OR REPLACE FUNCTION capability_session_pin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'ChatThread' THEN
    IF OLD."assistantId" IS DISTINCT FROM NEW."assistantId"
      OR OLD."legacyRevisionUnresolved" IS DISTINCT FROM NEW."legacyRevisionUnresolved"
      OR (OLD."assistantRevisionId" IS DISTINCT FROM NEW."assistantRevisionId"
        AND (OLD."assistantRevisionId" IS NULL OR NEW."assistantRevisionId" IS NULL)) THEN
      RAISE EXCEPTION 'session owner is immutable and unresolved sessions cannot be rebound' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF OLD."agentId" IS DISTINCT FROM NEW."agentId"
      OR OLD."legacyRevisionUnresolved" IS DISTINCT FROM NEW."legacyRevisionUnresolved"
      OR (OLD."agentRevisionId" IS DISTINCT FROM NEW."agentRevisionId"
        AND (OLD."agentRevisionId" IS NULL OR NEW."agentRevisionId" IS NULL)) THEN
      RAISE EXCEPTION 'session owner is immutable and unresolved sessions cannot be rebound' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
