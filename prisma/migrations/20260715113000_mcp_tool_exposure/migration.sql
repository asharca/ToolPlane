-- Preserve existing behavior with `all`; allowlist + an empty array means no
-- MCP tools are exposed to AI clients.
CREATE TYPE "McpToolExposure" AS ENUM ('all', 'allowlist');

ALTER TABLE "Deployment"
ADD COLUMN "mcpToolExposure" "McpToolExposure" NOT NULL DEFAULT 'all',
ADD COLUMN "mcpAllowedTools" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
