import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { logSystemEvent } from "@/lib/observability/system";
import { workspaceAccessWhere } from "@/lib/workspace/scope";
import {
  lockStorageWorkspace,
  reserveWorkspaceStorage,
  StorageQuotaExceededError,
} from "@/lib/storage/user-quota";
import {
  attachmentObjectPath,
  AttachmentStorageError,
  AttachmentTooLargeError,
  EmptyAttachmentError,
  writeWorkspaceAttachment,
} from "./storage";
import { discardAttachmentUpload } from "./uploads";

export class AttachmentWorkspaceUnavailableError extends Error {}
export class AttachmentQuotaLimitedError extends StorageQuotaExceededError {}
export class AttachmentMetadataSaveError extends Error {}
export class AttachmentWriteError extends Error {}

export async function storeWorkspaceAttachment(input: {
  workspaceId: string;
  uploaderId: string;
  accessUserId?: string;
  filename: string;
  mimeType: string;
  body: ReadableStream<Uint8Array>;
  maxBytes: number;
  announcedSize?: number | null;
  conversationId?: string;
  origin?: "upload" | "artifact";
  uploaderOnly?: boolean;
  sourceTaskFileId?: string;
  expectedSha256?: string;
  signal?: AbortSignal;
}) {
  const { workspaceId, uploaderId, filename, maxBytes, announcedSize } = input;
  if (announcedSize != null && announcedSize > maxBytes)
    throw new AttachmentTooLargeError(maxBytes);
  const objectId = randomUUID();
  const reservation = await db
    .$transaction(async (tx) => {
      const locked = await lockStorageWorkspace(tx, workspaceId);
      if (locked?.status !== "active")
        throw new AttachmentWorkspaceUnavailableError();
      if (input.accessUserId !== undefined) {
        const accessible = await tx.workspace.findFirst({
          where: {
            id: workspaceId,
            ...workspaceAccessWhere(input.accessUserId),
          },
          select: { id: true },
        });
        if (!accessible) throw new AttachmentWorkspaceUnavailableError();
      }
      const size = await reserveWorkspaceStorage(
        tx,
        locked,
        maxBytes,
        uploaderId,
      );
      if (announcedSize != null && announcedSize > size)
        throw new StorageQuotaExceededError();
      return tx.workspaceAttachment.create({
        data: {
          workspaceId,
          uploadedById: uploaderId,
          name: filename,
          mimeType: input.mimeType,
          status: "uploading",
          uploadStartedAt: new Date(),
          storagePath: attachmentObjectPath(objectId, filename),
          size,
          conversationId: input.conversationId,
          origin: input.origin,
          uploaderOnly: input.uploaderOnly,
          sourceTaskFileId: input.sourceTaskFileId,
        },
      });
    })
    .catch((error: unknown) => {
      if (
        !(
          error instanceof AttachmentWorkspaceUnavailableError ||
          error instanceof StorageQuotaExceededError
        )
      )
        logSystemEvent("attachments.metadata.reserve_failed", {
          error,
          workspaceId,
          actorId: uploaderId,
        });
      throw error;
    });

  try {
    const stored = await writeWorkspaceAttachment({
      workspaceId,
      filename,
      objectId,
      body: input.body,
      maxBytes: reservation.size,
      signal: input.signal,
    }).catch((error: unknown) => {
      if (
        error instanceof AttachmentTooLargeError &&
        reservation.size < maxBytes
      )
        throw new AttachmentQuotaLimitedError();
      if (
        error instanceof AttachmentTooLargeError ||
        error instanceof EmptyAttachmentError ||
        error instanceof AttachmentStorageError
      )
        throw error;
      throw new AttachmentWriteError("Attachment upload failed.", {
        cause: error,
      });
    });
    if (
      input.expectedSha256 !== undefined &&
      input.expectedSha256 !== stored.sha256
    )
      throw new AttachmentStorageError("Attachment checksum mismatch.");
    return await db.workspaceAttachment
      .update({
        where: {
          id: reservation.id,
          status: "uploading",
          uploadStartedAt: { not: null },
        },
        data: { status: "ready", size: stored.size, uploadStartedAt: null },
      })
      .catch((cause: unknown) => {
        logSystemEvent("attachments.metadata.save_failed", {
          error: cause,
          workspaceId,
          actorId: uploaderId,
        });
        throw new AttachmentMetadataSaveError(
          "Could not save attachment metadata.",
          { cause },
        );
      });
  } catch (error) {
    await discardAttachmentUpload(reservation).catch((cleanupError) => {
      logSystemEvent("attachments.metadata.cleanup_failed", {
        error: cleanupError,
        workspaceId,
        actorId: uploaderId,
      });
    });
    if (
      error instanceof AttachmentStorageError ||
      error instanceof AttachmentWriteError
    )
      logSystemEvent("attachments.storage.write_failed", {
        error: error.cause ?? error,
        workspaceId,
        actorId: uploaderId,
      });
    throw error;
  }
}
