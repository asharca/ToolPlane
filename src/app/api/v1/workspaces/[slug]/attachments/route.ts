import { workspaceAccessWhere } from "@/lib/workspace/scope";
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
} from "@/lib/attachments/storage";
import {
  AttachmentMetadataSaveError,
  AttachmentWorkspaceUnavailableError,
  AttachmentWriteError,
  storeWorkspaceAttachment,
} from "@/lib/attachments/store";
import { StorageQuotaExceededError } from "@/lib/storage/user-quota";

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
    try {
      const attachment = await storeWorkspaceAttachment({
        workspaceId: workspace.id,
        uploaderId: user.id,
        accessUserId: user.id,
        filename,
        mimeType: requestMimeType(req),
        body: req.body,
        maxBytes,
        announcedSize,
        signal: req.signal,
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
      if (error instanceof AttachmentWorkspaceUnavailableError)
        return Response.json({ error: "Workspace not found" }, { status: 404 });
      if (error instanceof StorageQuotaExceededError) return quotaExceeded();
      if (error instanceof AttachmentTooLargeError)
        return Response.json(
          {
            error: `Attachment exceeds the ${formatAttachmentByteLimit(maxBytes)} limit.`,
          },
          { status: 413 },
        );
      if (error instanceof EmptyAttachmentError)
        return Response.json({ error: error.message }, { status: 400 });
      if (
        error instanceof AttachmentStorageError ||
        error instanceof AttachmentWriteError
      )
        return Response.json(
          {
            error:
              error instanceof AttachmentStorageError
                ? "Attachment storage is unavailable."
                : "Attachment upload failed.",
          },
          { status: 502 },
        );
      return Response.json(
        {
          error:
            error instanceof AttachmentMetadataSaveError
              ? error.message
              : "Could not reserve attachment storage.",
        },
        { status: 500 },
      );
    }
  },
);
