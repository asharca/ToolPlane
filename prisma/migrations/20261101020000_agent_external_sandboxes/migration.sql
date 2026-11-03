-- CreateTable
CREATE TABLE "AgentExternalSandbox" (
    "agentId" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'read',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentExternalSandbox_pkey" PRIMARY KEY ("agentId","sandboxId"),
    CONSTRAINT "AgentExternalSandbox_access_check" CHECK ("access" IN ('read', 'write', 'full'))
);

-- CreateIndex
CREATE INDEX "AgentExternalSandbox_sandboxId_idx" ON "AgentExternalSandbox"("sandboxId");

-- AddForeignKey
ALTER TABLE "AgentExternalSandbox" ADD CONSTRAINT "AgentExternalSandbox_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentExternalSandbox" ADD CONSTRAINT "AgentExternalSandbox_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "Sandbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AgentSandbox now holds only the Agent's own template. Secondary bindings
-- become read-only external attachments; access must be raised explicitly.
INSERT INTO "AgentExternalSandbox" ("agentId", "sandboxId", "access")
SELECT "agentId", "sandboxId", 'read' FROM "AgentSandbox" WHERE NOT "isDefault"
ON CONFLICT DO NOTHING;
DELETE FROM "AgentSandbox" WHERE NOT "isDefault";
