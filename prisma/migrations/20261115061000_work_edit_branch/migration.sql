ALTER TABLE "Conversation"
  ADD COLUMN "branchedFromConversationId" TEXT,
  ADD COLUMN "branchedFromMessageId" TEXT;
ALTER TABLE "Message"
  ADD COLUMN "piEntryId" TEXT,
  ADD COLUMN "piParentEntryId" TEXT,
  ADD COLUMN "piTurnLeafId" TEXT,
  ADD COLUMN "piRewindEntryId" TEXT,
  ADD COLUMN "supersededAt" TIMESTAMP(3),
  ADD COLUMN "supersededById" TEXT;
CREATE INDEX "Message_conversationId_supersededAt_idx" ON "Message"("conversationId", "supersededAt");
