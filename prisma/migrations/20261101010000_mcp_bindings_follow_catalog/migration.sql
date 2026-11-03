-- Bindings follow the complete catalog; deployment exposure is the only tool filter.
CREATE OR REPLACE FUNCTION pg_temp.mcp_catalog_names(cfg jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(array_agg(DISTINCT tool->>'name' ORDER BY tool->>'name'), ARRAY[]::text[])
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(cfg->'toolCatalog') = 'array' THEN cfg->'toolCatalog' ELSE '[]'::jsonb END
  ) AS tool
  WHERE jsonb_typeof(tool->'name') = 'string' AND tool->>'name' <> ''
$$;

UPDATE "AgentServer" s SET "allowedToolNames" = pg_temp.mcp_catalog_names(d."installCfg"::jsonb)
FROM "Deployment" d WHERE d.id = s."deploymentId";
UPDATE "ChatAssistantMcpGrant" g SET "allowedToolNames" = pg_temp.mcp_catalog_names(d."installCfg"::jsonb)
FROM "Deployment" d WHERE d.id = g."deploymentId";

ALTER TABLE "AgentServer" DROP COLUMN "toolSelection";
ALTER TABLE "ChatAssistantMcpGrant" DROP COLUMN "toolSelection";
DROP TYPE "McpToolSelection";
