import "server-only";
import type { Prisma } from "@prisma/client";
import type { ComposerReference } from "@/lib/work/composer-types";
import { db } from "@/lib/db";
import { sandboxVolumeName } from "@/lib/sandboxes/runtime";
import { posix } from "node:path";
import { agentSessionWorkingDirectory } from "@/lib/agents/session-paths";
import {
  copyWorkspaceAttachmentToDockerVolume,
  safeAttachmentFilename,
} from "./storage";

const MAX_ATTACHMENTS_PER_MESSAGE = 5;

export class WorkAttachmentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WorkAttachmentError";
  }
}

export type PreparedWorkAttachment = {
  id: string;
  name: string;
  mimeType: string;
  runtimePath: string;
};

function attachmentIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new WorkAttachmentError(
      400,
      `At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments are allowed.`,
    );
  }
  const ids = value.map((item) =>
    typeof item === "string" ? item.trim() : "",
  );
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new WorkAttachmentError(400, "Invalid attachmentIds.");
  }
  return ids;
}

function destinationPath(
  workingDirectory: string,
  id: string,
  name: string,
): string {
  const prefix =
    workingDirectory === "." ? "" : `${workingDirectory.replace(/\/+$/, "")}/`;
  return `${prefix}.toolplane/attachments/${id}/${safeAttachmentFilename(name)}`;
}

export async function prepareWorkAttachments(input: {
  workspaceId: string;
  userId: string;
  sandboxId: string;
  workingDirectory: string;
  attachmentIds: unknown;
  conversationId?: string;
}): Promise<PreparedWorkAttachment[]> {
  const ids = attachmentIds(input.attachmentIds);
  if (!ids.length) return [];

  const [sandbox, records] = await Promise.all([
    db.sandbox.findFirst({
      where: { id: input.sandboxId, workspaceId: input.workspaceId },
      select: {
        id: true,
        kind: true,
        config: true,
        deployment: { select: { installCfg: true } },
      },
    }),
    db.workspaceAttachment.findMany({
      where: {
        id: { in: ids },
        workspaceId: input.workspaceId,
        uploadedById: input.userId,
        chatThreadId: null,
        OR: [
          { conversationId: null },
          ...(input.conversationId
            ? [{ conversationId: input.conversationId }]
            : []),
        ],
      },
      select: { id: true, name: true, mimeType: true, storagePath: true },
    }),
  ]);
  if (!sandbox) throw new WorkAttachmentError(404, "Sandbox not found.");
  const sandboxConfig = sandbox.config;
  if (
    sandboxConfig &&
    typeof sandboxConfig === "object" &&
    !Array.isArray(sandboxConfig) &&
    sandboxConfig.readOnly === true
  )
    throw new WorkAttachmentError(
      409,
      "Historical Agent workspaces are read-only.",
    );
  if (sandbox.kind !== "docker")
    throw new WorkAttachmentError(
      400,
      "Work attachments require a Docker-backed sandbox.",
    );
  if (records.length !== ids.length) {
    throw new WorkAttachmentError(
      409,
      "One or more attachments are unavailable or already in use.",
    );
  }

  const config = (sandbox.deployment.installCfg ?? {}) as {
    volumeName?: unknown;
  };
  const volumeName =
    typeof config.volumeName === "string" && config.volumeName
      ? config.volumeName
      : sandboxVolumeName(sandbox.id);
  const byId = new Map(records.map((record) => [record.id, record]));
  let workingDirectory = input.workingDirectory;
  if (input.conversationId) {
    const conversation = await db.conversation.findFirst({
      where: {
        id: input.conversationId,
        agent: { workspaceId: input.workspaceId },
      },
      select: { agentId: true, sandboxId: true },
    });
    if (!conversation)
      throw new WorkAttachmentError(404, "Conversation not found.");
    if (conversation.sandboxId !== sandbox.id)
      throw new WorkAttachmentError(409, "Conversation workspace changed.");
    if (
      sandboxConfig &&
      typeof sandboxConfig === "object" &&
      !Array.isArray(sandboxConfig) &&
      sandboxConfig.scope === "agent"
    )
      workingDirectory = posix.relative(
        "/workspace",
        agentSessionWorkingDirectory(
          { conversationId: input.conversationId },
          input.workingDirectory,
        ),
      );
  }
  const prepared: PreparedWorkAttachment[] = [];
  for (const id of ids) {
    const record = byId.get(id);
    if (!record) {
      throw new WorkAttachmentError(
        409,
        "One or more attachments are unavailable or already in use.",
      );
    }
    const path = destinationPath(workingDirectory, record.id, record.name);
    await copyWorkspaceAttachmentToDockerVolume({
      workspaceId: input.workspaceId,
      storagePath: record.storagePath,
      destinationVolume: volumeName,
      destinationPath: path,
    });
    prepared.push({
      id: record.id,
      name: record.name,
      mimeType: record.mimeType,
      runtimePath: `/workspace/${path}`,
    });
  }
  return prepared;
}

/** Called only while a new session workspace is being initialized. */
export async function materializeConversationAttachments(input: {
  workspaceId: string;
  conversationId: string;
  volumeName: string;
  workspaceRoot: string;
}): Promise<void> {
  const conversation = await db.conversation.findFirst({
    where: {
      id: input.conversationId,
      agent: { workspaceId: input.workspaceId },
    },
    select: { id: true },
  });
  if (!conversation)
    throw new WorkAttachmentError(404, "Conversation not found.");
  const records = await db.workspaceAttachment.findMany({
    where: {
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      chatThreadId: null,
    },
    select: { id: true, name: true, storagePath: true },
  });
  if (!records.length) return;
  const messages = await db.message.findMany({
    where: { conversationId: input.conversationId, role: "user" },
    select: { parts: true },
  });
  const destinations = new Map<string, string>();
  for (const message of messages) {
    if (!Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (
        !part ||
        typeof part !== "object" ||
        Array.isArray(part) ||
        part.type !== "file"
      )
        continue;
      const metadata = part.providerMetadata;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
        continue;
      const toolplane = metadata.toolplane;
      if (
        !toolplane ||
        typeof toolplane !== "object" ||
        Array.isArray(toolplane)
      )
        continue;
      if (
        typeof part.url === "string" &&
        typeof toolplane.runtimePath === "string"
      )
        destinations.set(part.url, toolplane.runtimePath);
    }
  }
  for (const record of records) {
    const original = destinations.get(`/api/v1/attachments/${record.id}`);
    if (!original) continue;
    const suffix = `/.toolplane/attachments/${record.id}/${safeAttachmentFilename(record.name)}`;
    if (!original.endsWith(suffix))
      throw new WorkAttachmentError(409, "Invalid attachment destination.");
    const destination = agentSessionWorkingDirectory(
      { conversationId: input.conversationId },
      original,
    );
    if (!destination.startsWith(`${input.workspaceRoot}/`))
      throw new WorkAttachmentError(409, "Attachment workspace mismatch.");
    await copyWorkspaceAttachmentToDockerVolume({
      workspaceId: input.workspaceId,
      storagePath: record.storagePath,
      destinationVolume: input.volumeName,
      destinationPath: posix.relative("/workspace", destination),
      exclusive: true,
    });
  }
}

export async function claimWorkAttachments(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    userId: string;
    conversationId: string;
    attachments: PreparedWorkAttachment[];
  },
): Promise<void> {
  for (const attachment of input.attachments) {
    const claimed = await tx.workspaceAttachment.updateMany({
      where: {
        id: attachment.id,
        workspaceId: input.workspaceId,
        uploadedById: input.userId,
        chatThreadId: null,
        OR: [
          { conversationId: null },
          { conversationId: input.conversationId },
        ],
      },
      data: { conversationId: input.conversationId },
    });
    if (claimed.count !== 1) {
      throw new WorkAttachmentError(
        409,
        "An attachment was claimed by another conversation.",
      );
    }
  }
}

export function workMessageParts(
  text: string,
  attachments: PreparedWorkAttachment[],
  references: ComposerReference[] = [],
) {
  return [
    { type: "text", text },
    ...references.map(({ text, ...reference }) => ({
      type: "text",
      text,
      reference,
    })),
    ...attachments.map((attachment) => ({
      type: "file",
      mediaType: attachment.mimeType,
      filename: attachment.name,
      url: `/api/v1/attachments/${attachment.id}`,
      providerMetadata: { toolplane: { runtimePath: attachment.runtimePath } },
    })),
  ];
}
