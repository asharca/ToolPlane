CREATE TABLE "PiSessionPackageSet" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sandboxId" TEXT UNIQUE,
  "conversationId" TEXT UNIQUE,
  "contextId" TEXT UNIQUE,
  "legacy" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PiSessionPackageSet_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "Sandbox"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PiSessionPackageSet_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PiSessionPackageSet_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "A2AContext"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "PiSessionPackage" (
  "packageSetId" TEXT NOT NULL,
  "marketInstallId" TEXT NOT NULL,
  "releaseId" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "resourceMap" JSONB NOT NULL,
  PRIMARY KEY ("packageSetId", "marketInstallId"),
  CONSTRAINT "PiSessionPackage_packageSetId_fkey" FOREIGN KEY ("packageSetId") REFERENCES "PiSessionPackageSet"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PiSessionPackage_marketInstallId_fkey" FOREIGN KEY ("marketInstallId") REFERENCES "MarketInstall"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PiSessionPackage_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "MarketRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "PiSessionPackage_marketInstallId_idx" ON "PiSessionPackage"("marketInstallId");
CREATE INDEX "PiSessionPackage_releaseId_idx" ON "PiSessionPackage"("releaseId");
-- Legacy references are recovered lazily only from checksum-matching private state.
INSERT INTO "PiSessionPackageSet" ("id", "sandboxId", "conversationId", "legacy")
SELECT s.id, s.id, c.id, true FROM "Sandbox" s
JOIN "Agent" a ON s.config->>'agentId' = a.id
LEFT JOIN "Conversation" c ON c."sandboxId" = s.id
WHERE s.config->>'managedBy' = 'agent-conversation' AND a."runtimeKind" = 'pi-sdk';
-- Every pre-upgrade Pi conversation is legacy, including template-based/unallocated ones.
INSERT INTO "PiSessionPackageSet" ("id", "conversationId", "legacy")
SELECT c.id, c.id, true FROM "Conversation" c JOIN "Agent" a ON a.id = c."agentId"
WHERE a."runtimeKind" = 'pi-sdk' AND NOT EXISTS (
  SELECT 1 FROM "PiSessionPackageSet" s WHERE s."conversationId" = c.id
);
-- Completed SDK Work can outlive a later Agent runtime change.
INSERT INTO "PiSessionPackageSet" ("id", "conversationId", "legacy")
SELECT w."conversationId", w."conversationId", true FROM "WorkSession" w
WHERE w."runtimeKind" = 'pi-sdk' AND NOT EXISTS (
  SELECT 1 FROM "PiSessionPackageSet" s WHERE s."conversationId" = w."conversationId"
);
-- Standalone local A2A contexts without an allocated set also need a legacy marker.
-- Chat/Work-bound contexts use the conversation marker, not a competing package set.
INSERT INTO "PiSessionPackageSet" ("id", "contextId", "legacy")
SELECT x.id, x.id, true FROM "A2AContext" x JOIN "Agent" a ON a.id = x."agentId"
WHERE x."targetKind" = 'local' AND a."runtimeKind" = 'pi-sdk'
AND NOT EXISTS (SELECT 1 FROM "PiSessionPackageSet" s WHERE s."sandboxId" = x."sandboxId")
AND NOT EXISTS (
  SELECT 1 FROM "A2AEntryBinding" e JOIN "Conversation" c ON c."agentId" = x."agentId"
  LEFT JOIN "WorkSession" w ON w."conversationId" = c.id
  WHERE e."contextId" = x.id AND (
    (e.kind IN ('chat', 'control', 'channel') AND e."sourceId" = c.id)
    OR (e.kind = 'work' AND e."sourceId" = w.id)
  )
);
-- WorkSession.conversationId is UNIQUE; one Work row can contribute to each set.
-- Code refs were recorded at admission. '{}' is not an inferred grant: legacy stays
-- true until runtime proves current effective MCP policy matches admission checksum.
INSERT INTO "PiSessionPackage" ("packageSetId", "marketInstallId", "releaseId", "checksum", "resourceMap")
SELECT s.id, ref->>'marketInstallId', ref->>'releaseId', ref->>'checksum', '{}'::jsonb
FROM "WorkSession" w JOIN "PiSessionPackageSet" s ON s."conversationId" = w."conversationId"
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w."runtimeSnapshot"->'piPackages', '[]'::jsonb)) ref
JOIN "MarketInstall" i ON i.id = ref->>'marketInstallId' AND i."targetWorkspaceId" = w."workspaceId"
JOIN "MarketRelease" r ON r.id = ref->>'releaseId' AND r."listingId" = i."listingId" AND r.checksum = ref->>'checksum'
WHERE w."runtimeKind" = 'pi-sdk';
