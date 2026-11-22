-- CreateEnum
CREATE TYPE "WorkspaceAttachmentOrigin" AS ENUM ('upload', 'artifact');

-- AlterTable
ALTER TABLE "WorkspaceAttachment" ADD COLUMN     "origin" "WorkspaceAttachmentOrigin" NOT NULL DEFAULT 'upload',
ADD COLUMN     "sourceTaskFileId" TEXT,
ADD COLUMN     "uploaderOnly" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceAttachment_sourceTaskFileId_key" ON "WorkspaceAttachment"("sourceTaskFileId");
