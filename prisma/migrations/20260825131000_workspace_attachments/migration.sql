CREATE TABLE "WorkspaceAttachment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "chatThreadId" TEXT,
    "conversationId" TEXT,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "extractedText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceAttachment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkspaceAttachment_size_check" CHECK ("size" > 0),
    CONSTRAINT "WorkspaceAttachment_owner_check" CHECK (NOT ("chatThreadId" IS NOT NULL AND "conversationId" IS NOT NULL))
);

CREATE UNIQUE INDEX "WorkspaceAttachment_workspaceId_storagePath_key" ON "WorkspaceAttachment"("workspaceId", "storagePath");
CREATE INDEX "WorkspaceAttachment_workspaceId_createdAt_idx" ON "WorkspaceAttachment"("workspaceId", "createdAt");
CREATE INDEX "WorkspaceAttachment_chatThreadId_idx" ON "WorkspaceAttachment"("chatThreadId");
CREATE INDEX "WorkspaceAttachment_conversationId_idx" ON "WorkspaceAttachment"("conversationId");

ALTER TABLE "WorkspaceAttachment" ADD CONSTRAINT "WorkspaceAttachment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceAttachment" ADD CONSTRAINT "WorkspaceAttachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceAttachment" ADD CONSTRAINT "WorkspaceAttachment_chatThreadId_fkey" FOREIGN KEY ("chatThreadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceAttachment" ADD CONSTRAINT "WorkspaceAttachment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
