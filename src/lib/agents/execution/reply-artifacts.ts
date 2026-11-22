import "server-only";
import { TaskState } from "@a2a-js/sdk";
import { Prisma } from "@prisma/client";
import { readWorkspaceAttachment } from "@/lib/attachments/storage";
import { storeWorkspaceAttachment } from "@/lib/attachments/store";
import { taskFileUrl } from "@/lib/conversation/a2a-parts";
import { db } from "@/lib/db";
import { recordEvent } from "@/lib/observability/events";

export type ReplyArtifact = {
  taskId: string;
  fileId: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  producer: { agentId: string | null; name: string };
};

export type CapturedArtifact = ReplyArtifact & {
  attachmentId: string | null;
  url: string;
};

const MAX_REPLY_ARTIFACTS = 20;
const readyFile = {
  status: "ready",
  storagePath: { not: null },
  size: { not: null },
  sha256: { not: null },
};
const fileMetadata = {
  id: true,
  taskId: true,
  filename: true,
  mimeType: true,
  size: true,
  sha256: true,
} as const;

// Snapshots are stored as Task ProtoJSON. Read handles without decoding inline bytes.
type PublishedSnapshot = {
  artifacts?: { parts?: { metadata?: { toolplaneFileId?: unknown } }[] }[];
};

function publishedFileIds(snapshot: Prisma.JsonValue): string[] {
  const ids: string[] = [];
  for (const artifact of (snapshot as PublishedSnapshot | null)?.artifacts ??
    []) {
    for (const part of artifact.parts ?? []) {
      const id = part.metadata?.toolplaneFileId;
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

export async function listReplyArtifacts(
  entryTaskId: string,
): Promise<ReplyArtifact[]> {
  const entry = await db.a2ATask.findUnique({
    where: { id: entryTaskId },
    select: { context: { select: { workspaceId: true } } },
  });
  if (!entry) return [];
  const { workspaceId } = entry.context;
  const tasks = await db.a2ATask.findMany({
    where: {
      OR: [{ id: entryTaskId }, { rootTaskId: entryTaskId }],
      state: TaskState.TASK_STATE_COMPLETED,
      context: { workspaceId },
    },
    select: {
      id: true,
      snapshot: true,
      statusAt: true,
      context: {
        select: {
          agent: { select: { id: true, name: true } },
          remoteAgent: { select: { id: true, name: true } },
        },
      },
    },
  });
  // Preserve the child's attribution when an entry task publishes its output again.
  tasks.sort(
    (a, b) =>
      Number(a.id === entryTaskId) - Number(b.id === entryTaskId) ||
      a.statusAt.getTime() - b.statusAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  const published = tasks.map((task) => ({
    task,
    ids: publishedFileIds(task.snapshot),
  }));
  const ids = published.flatMap((item) => item.ids);
  if (!ids.length) return [];
  const files = await db.a2ATaskFile.findMany({
    where: {
      ...readyFile,
      workspaceId,
      taskId: { in: tasks.map((task) => task.id) },
      id: { in: ids },
      expiresAt: { gt: new Date() },
    },
    select: fileMetadata,
  });
  const byId = new Map(files.map((file) => [file.id, file]));
  const seen = new Set<string>();
  const result: ReplyArtifact[] = [];
  for (const { task, ids } of published) {
    const producer = task.context.agent ?? task.context.remoteAgent;
    for (const id of ids) {
      const file = byId.get(id);
      if (
        !file ||
        file.taskId !== task.id ||
        file.size === null ||
        !file.sha256 ||
        seen.has(file.sha256)
      )
        continue;
      if (result.length === MAX_REPLY_ARTIFACTS) {
        await recordEvent({
          domain: "agent",
          eventName: "agent.reply_artifacts.truncated",
          level: "info",
          workspaceId,
          taskId: entryTaskId,
        });
        return result;
      }
      seen.add(file.sha256);
      result.push({
        taskId: task.id,
        fileId: file.id,
        filename: file.filename,
        mediaType: file.mimeType,
        size: file.size,
        sha256: file.sha256,
        producer: { agentId: producer?.id ?? null, name: producer?.name ?? "" },
      });
    }
  }
  return result;
}

export async function captureReplyArtifacts(input: {
  workspaceId: string;
  conversationId: string;
  uploaderId: string;
  privateEntry: boolean;
  entryTaskId: string;
  artifacts: readonly ReplyArtifact[];
  signal?: AbortSignal;
}): Promise<CapturedArtifact[]> {
  const { workspaceId, conversationId, uploaderId, entryTaskId, signal } =
    input;
  const captured: CapturedArtifact[] = [];
  for (const artifact of input.artifacts) {
    const { fileId, taskId } = artifact;
    const uploaderOnly = input.privateEntry && taskId === entryTaskId;
    const fallbackUrl = taskFileUrl(fileId, taskId);
    const { filename, mediaType, size, sha256, producer } = artifact;
    let metadata = {
      taskId,
      fileId,
      filename,
      mediaType,
      size,
      sha256,
      producer,
    };
    try {
      const findReadyCopy = () =>
        db.workspaceAttachment.findFirst({
          where: {
            sourceTaskFileId: fileId,
            workspaceId,
            origin: "artifact",
            status: "ready",
            uploaderOnly,
            ...(uploaderOnly ? { uploadedById: uploaderId } : {}),
          },
          select: { id: true },
        });
      let attachment = await findReadyCopy();
      if (attachment) {
        captured.push({
          ...metadata,
          attachmentId: attachment.id,
          url: `/api/v1/attachments/${attachment.id}`,
        });
        continue;
      }
      // A listed artifact is a handle, not authority to read its claimed path or size.
      const file = await db.a2ATaskFile.findFirst({
        where: {
          ...readyFile,
          id: fileId,
          taskId,
          workspaceId,
          expiresAt: { gt: new Date() },
          task: {
            context: { workspaceId },
            OR: [{ id: entryTaskId }, { rootTaskId: entryTaskId }],
          },
        },
        select: { ...fileMetadata, storagePath: true },
      });
      if (!file?.storagePath || file.size === null || !file.sha256)
        throw new Error("Reply artifact unavailable.");
      metadata = {
        taskId,
        fileId,
        filename: file.filename,
        mediaType: file.mimeType,
        size: file.size,
        sha256: file.sha256,
        producer: artifact.producer,
      };
      signal?.throwIfAborted();
      const body = readWorkspaceAttachment(
        workspaceId,
        file.storagePath,
        file.size,
      );
      try {
        attachment = await storeWorkspaceAttachment({
          workspaceId,
          conversationId,
          uploaderId,
          uploaderOnly,
          body,
          signal,
          filename: file.filename,
          mimeType: file.mimeType,
          maxBytes: file.size,
          announcedSize: file.size,
          expectedSha256: file.sha256,
          origin: "artifact",
          sourceTaskFileId: fileId,
        });
      } catch (error) {
        if (
          !(
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          )
        )
          throw error;
        attachment = await findReadyCopy();
        if (!attachment) throw error; // The winning reservation may still be uploading.
      } finally {
        // Reservation failures happen before the store consumes the source stream.
        if (!body.locked) await body.cancel().catch(() => {});
      }
      captured.push({
        ...metadata,
        attachmentId: attachment.id,
        url: `/api/v1/attachments/${attachment.id}`,
      });
    } catch (error) {
      const errorClass =
        error instanceof Error ? error.constructor.name : "Error";
      await recordEvent({
        domain: "agent",
        eventName: "agent.reply_artifact.capture_failed",
        level: "warn",
        outcome: "error",
        workspaceId,
        conversationId,
        actorId: uploaderId,
        taskId,
        path: fallbackUrl,
        attributes: { fileId, errorClass },
        error: { name: errorClass },
      });
      captured.push({ ...metadata, attachmentId: null, url: fallbackUrl });
    }
  }
  return captured;
}

export function replyArtifactParts(captured: readonly CapturedArtifact[]) {
  return captured.map(({ url, filename, mediaType, size, producer }) => ({
    type: "file" as const,
    url,
    filename,
    mediaType,
    providerMetadata: {
      toolplane: { origin: "artifact" as const, filename, size, producer },
    },
  }));
}
