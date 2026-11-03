-- Package pins belong to a conversation/context, not exclusively to its container.
ALTER TABLE "PiSessionPackageSet" DROP CONSTRAINT "PiSessionPackageSet_sandboxId_key";
CREATE INDEX "PiSessionPackageSet_sandboxId_idx" ON "PiSessionPackageSet"("sandboxId");

-- Repair already-migrated sessions without modifying their immutable package pins.
UPDATE "PiSessionPackageSet" p SET "sandboxId" = c."sandboxId"
FROM "Conversation" c JOIN "Agent" a ON a.id = c."agentId"
JOIN "Sandbox" s ON s.id = c."sandboxId" AND s."workspaceId" = a."workspaceId"
WHERE p."conversationId" = c.id
  AND s.config->>'managedBy' = 'agent-conversation'
  AND s.config->>'scope' = 'agent'
  AND s.config->>'agentId' = c."agentId"
  AND p."sandboxId" IS DISTINCT FROM c."sandboxId";

UPDATE "PiSessionPackageSet" p SET "sandboxId" = c."sandboxId"
FROM "A2AContext" c JOIN "Sandbox" s ON s.id = c."sandboxId" AND s."workspaceId" = c."workspaceId"
WHERE p."contextId" = c.id AND p."conversationId" IS NULL AND c."targetKind" = 'local'
  AND s.config->>'managedBy' = 'agent-conversation'
  AND s.config->>'scope' = 'agent'
  AND s.config->>'agentId' = c."agentId"
  AND p."sandboxId" IS DISTINCT FROM c."sandboxId";
