ALTER TABLE "Conversation" ADD COLUMN "sandboxId" TEXT;
ALTER TABLE "A2AContext" ADD COLUMN "sandboxId" TEXT;
CREATE UNIQUE INDEX "Conversation_sandboxId_key" ON "Conversation"("sandboxId");
CREATE INDEX "Conversation_sandboxId_idx" ON "Conversation"("sandboxId");
CREATE INDEX "A2AContext_sandboxId_idx" ON "A2AContext"("sandboxId");
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "Sandbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "A2AContext" ADD CONSTRAINT "A2AContext_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "Sandbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
