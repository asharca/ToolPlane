import { randomUUID } from "node:crypto";
import { workspaceAccessWhere } from "@/lib/workspace/scope";
import { logSystemEvent } from "@/lib/observability/system";
import { withRequestLogging } from "@/lib/observability/http";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { db } from "@/lib/db";
import {
  formatAttachmentByteLimit,
  maxAgentAttachmentBytes,
} from "@/lib/agents/attachment-limits";
import {
  AttachmentStorageError,
  AttachmentTooLargeError,
  EmptyAttachmentError,
  attachmentObjectPath,
  writeWorkspaceAttachment,
} from "@/lib/attachments/storage";
import { discardAttachmentUpload } from "@/lib/attachments/uploads";
import {
  lockStorageWorkspace,
  reserveWorkspaceStorage,
  StorageQuotaExceededError,
} from "@/lib/storage/user-quota";

export const runtime = "nodejs";
export const maxDuration = 900;

function requestMimeType(req: Request): string {
  const value = req.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value)
    ? value.slice(0, 120)
    : "application/octet-stream";
}

function announcedContentLength(req: Request): number | null {
  const value = req.headers.get("content-length");
  if (value === null) return null;
  if (!/^\d+$/.test(value)) return Number.NaN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function quotaExceeded() {
  return Response.json(
    { error: "Storage quota exceeded.", code: "STORAGE_QUOTA_EXCEEDED" },
    { status: 413 },
  );
}

export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/attachments",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ slug: string }> },
  ) {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const { slug: workspaceId } = await params;
    const workspace = await db.workspace.findFirst({
      where: {
        id: workspaceId,
        ...workspaceAccessWhere(user.id),
      },
      select: { id: true },
    });
    if (!workspace)
      return Response.json({ error: "Workspace not found" }, { status: 404 });
    if (
      req.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("multipart/form-data")
    ) {
      return Response.json(
        {
          error:
            "Multipart attachment uploads are not supported; send the raw file body.",
        },
        { status: 415 },
      );
    }

    const filename =
      new URL(req.url).searchParams.get("filename")?.trim() ?? "";
    const announcedSize = announcedContentLength(req);
    if (
      !filename ||
      filename.length > 240 ||
      !req.body ||
      Number.isNaN(announcedSize)
    ) {
      return Response.json(
        { error: "A valid filename and non-empty raw file body are required." },
        { status: 400 },
      );
    }
    const maxBytes = await maxAgentAttachmentBytes();
    if (announcedSize !== null && announcedSize > maxBytes) {
      return Response.json(
        {
          error: `Attachment exceeds the ${formatAttachmentByteLimit(maxBytes)} limit.`,
        },
        { status: 413 },
      );
    }

    const objectId = randomUUID();
    const reservation = await db
      .$transaction(async (tx) => {
        const locked = await lockStorageWorkspace(tx, workspace.id);
        if (locked?.status !== "active") return null;
        const accessible = await tx.workspace.findFirst({
          where: { id: workspace.id, ...workspaceAccessWhere(user.id) },
          select: { id: true },
        });
        if (!accessible) return null;
        const size = await reserveWorkspaceStorage(
          tx,
          locked,
          maxBytes,
          user.id,
        );
        if (announcedSize !== null && announcedSize > size)
          throw new StorageQuotaExceededError();
        return tx.workspaceAttachment.create({
          data: {
            workspaceId: workspace.id,
            uploadedById: user.id,
            name: filename,
            mimeType: requestMimeType(req),
            status: "uploading",
            uploadStartedAt: new Date(),
            storagePath: attachmentObjectPath(objectId, filename),
            size,
          },
        });
      })
      .catch((error: unknown) => {
        if (error instanceof StorageQuotaExceededError) return quotaExceeded();
        logSystemEvent("attachments.metadata.reserve_failed", {
          error,
          workspaceId: workspace.id,
          actorId: user.id,
        });
        return Response.json(
          { error: "Could not reserve attachment storage." },
          { status: 500 },
        );
      });
    if (reservation instanceof Response) return reservation;
    if (!reservation)
      return Response.json({ error: "Workspace not found" }, { status: 404 });
    const discard = () =>
      discardAttachmentUpload(reservation).catch((error) => {
        logSystemEvent("attachments.metadata.cleanup_failed", {
          error,
          workspaceId: workspace.id,
          actorId: user.id,
        });
      });

    let stored: { size: number };
    try {
      stored = await writeWorkspaceAttachment({
        workspaceId: workspace.id,
        filename,
        body: req.body,
        objectId,
        maxBytes: reservation.size,
        signal: req.signal,
      });
    } catch (error) {
      await discard();
      if (error instanceof AttachmentTooLargeError) {
        if (reservation.size < maxBytes) return quotaExceeded();
        return Response.json(
          {
            error: `Attachment exceeds the ${formatAttachmentByteLimit(maxBytes)} limit.`,
          },
          { status: 413 },
        );
      }
      if (error instanceof EmptyAttachmentError) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      logSystemEvent("attachments.storage.write_failed", {
        error,
        workspaceId: workspace.id,
        actorId: user.id,
      });
      return Response.json(
        {
          error:
            error instanceof AttachmentStorageError
              ? "Attachment storage is unavailable."
              : "Attachment upload failed.",
        },
        { status: 502 },
      );
    }

    try {
      const attachment = await db.workspaceAttachment.update({
        where: {
          id: reservation.id,
          status: "uploading",
          uploadStartedAt: { not: null },
        },
        data: { status: "ready", size: stored.size, uploadStartedAt: null },
      });
      return Response.json(
        {
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
          url: `/api/v1/attachments/${attachment.id}`,
        },
        { status: 201 },
      );
    } catch (error) {
      logSystemEvent("attachments.metadata.save_failed", {
        error,
        workspaceId: workspace.id,
        actorId: user.id,
      });
      await discard();
      return Response.json(
        { error: "Could not save attachment metadata." },
        { status: 500 },
      );
    }
  },
);
