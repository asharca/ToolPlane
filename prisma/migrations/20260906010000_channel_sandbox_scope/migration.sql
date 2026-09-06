ALTER TABLE "AgentChannelConnection" ADD COLUMN "sandboxId" TEXT;

DROP INDEX "AgentChannelConnection_agentId_platform_name_key";
CREATE UNIQUE INDEX "AgentChannelConnection_sandboxId_platform_name_key" ON "AgentChannelConnection"("sandboxId", "platform", "name");

UPDATE "AgentChannelConnection" AS channel
SET "sandboxId" = COALESCE(
  (SELECT runtime."sandboxId" FROM "AgentRuntime" AS runtime
   WHERE runtime."agentId" = channel."agentId" AND runtime."workspaceId" = channel."workspaceId" LIMIT 1),
  (SELECT link."sandboxId" FROM "AgentSandbox" AS link
   JOIN "Sandbox" AS sandbox ON sandbox."id" = link."sandboxId"
   WHERE link."agentId" = channel."agentId" AND sandbox."workspaceId" = channel."workspaceId"
   ORDER BY link."isDefault" DESC, sandbox."createdAt" ASC LIMIT 1)
);

CREATE INDEX "AgentChannelConnection_workspaceId_sandboxId_idx" ON "AgentChannelConnection"("workspaceId", "sandboxId");
ALTER TABLE "AgentChannelConnection" ADD CONSTRAINT "AgentChannelConnection_sandboxId_fkey"
  FOREIGN KEY ("sandboxId") REFERENCES "Sandbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;
