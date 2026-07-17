-- Hermes agents receive a provider inventory and let Hermes choose models for
-- its main and auxiliary workloads. Native agents continue to use Agent's
-- providerId/model pair.
CREATE TABLE "AgentModelProvider" (
    "agentId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentModelProvider_pkey" PRIMARY KEY ("agentId", "providerId")
);

CREATE INDEX "AgentModelProvider_providerId_idx" ON "AgentModelProvider"("providerId");

ALTER TABLE "AgentModelProvider"
ADD CONSTRAINT "AgentModelProvider_agentId_fkey"
FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentModelProvider"
ADD CONSTRAINT "AgentModelProvider_providerId_fkey"
FOREIGN KEY ("providerId") REFERENCES "ModelProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "AgentModelProvider" ("agentId", "providerId")
SELECT agent."id", agent."providerId"
FROM "Agent" AS agent
INNER JOIN "AgentRuntime" AS runtime ON runtime."agentId" = agent."id"
WHERE runtime."kind" = 'hermes' AND agent."providerId" IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE "Agent" AS agent
SET "providerId" = NULL, "model" = NULL
FROM "AgentRuntime" AS runtime
WHERE runtime."agentId" = agent."id" AND runtime."kind" = 'hermes';
