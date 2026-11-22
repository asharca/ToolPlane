import { MAX_A2A_INLINE_BYTES } from "@/lib/transport-policy";

const MAX_INLINE_BASE64_LENGTH = Math.ceil(MAX_A2A_INLINE_BYTES / 3) * 4;
const SAFE_FILE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const SAFE_MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

export type A2AWirePart = {
  text?: string;
  data?: Record<string, unknown>;
  raw?: string;
  mediaType?: string;
  filename?: string;
  metadata?: Record<string, unknown>;
};

export type A2AContentPart = {
  type: string;
  [key: string]: unknown;
};

export function taskFileUrl(fileId: string, taskId: string): string {
  return `/api/v1/a2a/files/${encodeURIComponent(fileId)}/download?task=${encodeURIComponent(taskId)}`;
}

export function a2aWireContentParts(
  parts: readonly A2AWirePart[],
  options: { taskId: string; producer?: string },
): A2AContentPart[] {
  const result: A2AContentPart[] = [];
  const producer = options.producer?.trim() || undefined;

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;

    const fileId = part.metadata?.toolplaneFileId;
    if (typeof fileId === "string" && SAFE_FILE_ID.test(fileId)) {
      const filename =
        typeof part.filename === "string" && part.filename
          ? part.filename
          : undefined;
      const mediaType =
        typeof part.mediaType === "string" && part.mediaType
          ? part.mediaType
          : "application/octet-stream";
      result.push({
        type: "file",
        url: taskFileUrl(fileId, options.taskId),
        ...(filename ? { filename } : {}),
        mediaType,
        providerMetadata: {
          toolplane: {
            origin: "artifact",
            ...(filename ? { filename } : {}),
            ...(producer
              ? { producer: { agentId: null, name: producer } }
              : {}),
          },
        },
      });
      continue;
    }

    if (typeof part.text === "string") {
      result.push({ type: "text", text: part.text, state: "done" });
      continue;
    }

    if (part.data && typeof part.data === "object") {
      result.push({
        type: "text",
        text: `\`\`\`json\n${JSON.stringify(part.data, null, 2)}\n\`\`\``,
        state: "done",
      });
      continue;
    }

    if (
      typeof part.raw !== "string" ||
      part.raw.length > MAX_INLINE_BASE64_LENGTH ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(part.raw)
    ) {
      continue;
    }

    let decodedLength: number;
    try {
      const decoded = atob(part.raw);
      if (decoded.length > MAX_A2A_INLINE_BYTES || btoa(decoded) !== part.raw) {
        continue;
      }
      decodedLength = decoded.length;
    } catch {
      continue;
    }

    const mediaType =
      typeof part.mediaType === "string" && SAFE_MEDIA_TYPE.test(part.mediaType)
        ? part.mediaType
        : "application/octet-stream";
    const filename =
      typeof part.filename === "string" && part.filename
        ? part.filename
        : undefined;
    result.push({
      type: "file",
      url: `data:${mediaType};base64,${part.raw}`,
      ...(filename ? { filename } : {}),
      mediaType,
      providerMetadata: {
        toolplane: {
          origin: "artifact",
          ...(filename ? { filename } : {}),
          size: decodedLength,
          ...(producer ? { producer: { agentId: null, name: producer } } : {}),
        },
      },
    });
  }

  return result;
}
