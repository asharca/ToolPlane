ALTER TABLE "WorkSession" ADD COLUMN "a2aActorId" TEXT;
ALTER TABLE "AgentChannelConnection" ADD COLUMN "a2aActorId" TEXT;
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_a2aActorId_fkey" FOREIGN KEY ("a2aActorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentChannelConnection" ADD CONSTRAINT "AgentChannelConnection_a2aActorId_fkey" FOREIGN KEY ("a2aActorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TABLE "A2AEntryBinding" (
  "id" TEXT NOT NULL, "ownerKey" TEXT NOT NULL, "kind" TEXT NOT NULL, "sourceId" TEXT NOT NULL,
  "contextId" TEXT NOT NULL, "lastTaskId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "A2AEntryBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "A2AEntryBinding_kind_check" CHECK ("kind" IN ('chat','work','channel','control')),
  CONSTRAINT "A2AEntryBinding_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "A2AContext"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "A2AEntryBinding_lastTaskId_fkey" FOREIGN KEY ("lastTaskId") REFERENCES "A2ATask"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "A2AEntryBinding_ownerKey_kind_sourceId_key" ON "A2AEntryBinding"("ownerKey","kind","sourceId");
CREATE TABLE "A2AEntryReceipt" (
  "id" TEXT NOT NULL, "bindingId" TEXT NOT NULL, "messageId" TEXT NOT NULL, "inputHash" TEXT NOT NULL,
  "taskId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "A2AEntryReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "A2AEntryReceipt_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "A2AEntryBinding"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "A2AEntryReceipt_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "A2ATask"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "A2AEntryReceipt_bindingId_messageId_key" ON "A2AEntryReceipt"("bindingId","messageId");
CREATE INDEX "A2AEntryReceipt_taskId_idx" ON "A2AEntryReceipt"("taskId");
