import "server-only";
import type { Prisma } from "@prisma/client";
import { deleteWorkspaceAttachmentFile } from "@/lib/attachments/storage";
import { db } from "@/lib/db";
import { logSystemEvent } from "@/lib/observability/system";

// Allow the storage helper and its cleanup to finish before reclaiming uploads.
const STALE_UPLOAD_MS = 60 * 60_000;
type Upload = { id: string; workspaceId: string; storagePath: string };

// Caller holds the workspace storage lock. Hide the attachment and keep its
// charge until the same cleanup path used by abandoned uploads removes it.
export async function stageAttachmentDeletion(
  tx: Prisma.TransactionClient,
  workspace: Prisma.WorkspaceWhereInput,
  id: string,
  uploadedById?: string,
): Promise<Upload | "not_found" | "forbidden"> {
  const where = { id, workspace, status: "ready" } as const;
  const attachment = await tx.workspaceAttachment.findFirst({
    where,
    select: {
      id: true,
      workspaceId: true,
      storagePath: true,
      uploadedById: true,
    },
  });
  if (!attachment) return "not_found";
  if (uploadedById && attachment.uploadedById !== uploadedById)
    return "forbidden";
  const result = await tx.workspaceAttachment.updateMany({
    where: { ...where, uploadedById },
    data: {
      status: "uploading",
      uploadStartedAt: null,
      conversationId: null,
      chatThreadId: null,
    },
  });
  return result.count ? attachment : "not_found";
}

export async function removeAttachmentPendingCleanup(upload: Upload) {
  await deleteWorkspaceAttachmentFile(upload.workspaceId, upload.storagePath);
  await db.workspaceAttachment.deleteMany({
    where: { id: upload.id, status: "uploading", uploadStartedAt: null },
  });
}

async function removeUpload(upload: Upload) {
  try {
    await removeAttachmentPendingCleanup(upload);
  } catch (error) {
    // Keep the reservation and physical path so the sweeper can retry.
    logSystemEvent("attachments.storage.cleanup_failed", {
      error,
      level: "warn",
      workspaceId: upload.workspaceId,
      attributes: { attachmentId: upload.id },
    });
  }
}

export async function discardAttachmentUpload(upload: Upload) {
  const claimed = await db.workspaceAttachment.updateMany({
    where: { id: upload.id, status: "uploading" },
    data: { uploadStartedAt: null },
  });
  if (claimed.count) {
    await removeUpload(upload);
    return;
  }
  // If a concurrent sweep already removed the row, a late write can still
  // have published the object. Never delete an attachment that did become ready.
  const remaining = await db.workspaceAttachment.findUnique({
    where: { id: upload.id },
    select: { id: true },
  });
  if (!remaining) await removeUpload(upload);
}

export async function cleanupAttachmentUploads(now = new Date()) {
  const stale = {
    status: "uploading",
    OR: [
      { uploadStartedAt: { lte: new Date(now.getTime() - STALE_UPLOAD_MS) } },
      { uploadStartedAt: null },
    ],
  } satisfies Prisma.WorkspaceAttachmentWhereInput;
  const uploads = await db.workspaceAttachment.findMany({
    where: stale,
    select: { id: true, workspaceId: true, storagePath: true },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  for (const upload of uploads) {
    // Fence finalization before touching the file, without holding a lock over I/O.
    const claimed = await db.workspaceAttachment.updateMany({
      where: { id: upload.id, ...stale },
      data: { uploadStartedAt: null },
    });
    if (claimed.count) await removeUpload(upload);
  }
}
