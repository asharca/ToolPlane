import "server-only";
import type { Prisma } from "@prisma/client";
import { assertAssistantRemoteDeployment } from "@/lib/remote-mcp/classification";
import type { DeploymentForSpawn } from "@/lib/process/spawn-spec";
import { chatBranchNavigation, chatMessagePath } from "./branches";

export const providerForClient = {
  select: { id: true, name: true, format: true, models: true },
} as const;

export const grantForClient = {
  orderBy: { createdAt: "asc" as const },
  select: {
    deploymentId: true,
    allowedToolNames: true,
    deployment: {
      select: {
        id: true,
        name: true,
        source: true,
        status: true,
        server: {
          select: {
            name: true,
            slug: true,
            categories: { select: { slug: true } },
          },
        },
      },
    },
  },
} as const;

export class ChatServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatServiceError";
  }
}

export function requireChatRemoteDeployment(deployment: DeploymentForSpawn) {
  try {
    return assertAssistantRemoteDeployment(deployment);
  } catch {
    throw new ChatServiceError(
      400,
      "Assistants require a remote HTTP/SSE MCP connection, not a stdio gateway, local runtime, or Agent delegation endpoint",
    );
  }
}

type StoredChatMessage = {
  id: string;
  parentId: string | null;
  siblingGroupId: string | null;
  role: string;
  status: string;
  modelId: string | null;
  parts: Prisma.JsonValue;
  createdAt: Date;
};

export type ChatBranchNode = {
  id: string;
  parentId: string | null;
  role: string;
  status: string;
  modelId: string | null;
  createdAt: string;
  preview: string;
  active: boolean;
  awaitingInput: boolean;
};

function isAwaitingInput(message: Pick<StoredChatMessage, "role" | "parts">) {
  return (
    message.role === "user" &&
    Array.isArray(message.parts) &&
    message.parts.length === 0
  );
}

export function projectActiveChatBranch<
  T extends { activeMessageId: string | null; messages: StoredChatMessage[] },
>(thread: T | null) {
  if (!thread) return null;
  const path = chatMessagePath(thread.messages, thread.activeMessageId);
  const activeIds = new Set(path.map((message) => message.id));
  const parentIds = new Set(
    thread.messages.flatMap((message) =>
      message.parentId ? [message.parentId] : [],
    ),
  );
  const leafCount = thread.messages.filter(
    (message) => !parentIds.has(message.id),
  ).length;
  return {
    ...thread,
    messages: path.filter((message) => !isAwaitingInput(message)),
    branch: {
      activeMessageId: path.at(-1)?.id ?? null,
      branchCount: leafCount,
      navigation: chatBranchNavigation(thread.messages, path),
      nodes: thread.messages.map<ChatBranchNode>((message) => ({
        id: message.id,
        parentId: message.parentId,
        role: message.role,
        status: message.status,
        modelId: message.modelId,
        createdAt: message.createdAt.toISOString(),
        preview:
          messageTitle(
            Array.isArray(message.parts)
              ? (message.parts as Array<Record<string, unknown>>)
              : [],
          ) ?? (message.role === "user" ? "User message" : "Assistant message"),
        active: activeIds.has(message.id),
        awaitingInput: isAwaitingInput(message),
      })),
    },
  };
}

export async function assertChatRunsDeletable(
  tx: Prisma.TransactionClient,
  where: Prisma.ChatTurnWhereInput,
) {
  // Call only after locking every scoped thread; admission takes the same row lock.
  const unresolved = await tx.chatTurn.findFirst({
    where: {
      ...where,
      OR: [
        { status: "pending" },
        {
          confirmations: {
            some: { status: { in: ["executing", "execution_unknown"] } },
          },
        },
      ],
    },
    select: { id: true },
  });
  if (unresolved)
    throw new ChatServiceError(
      409,
      "Cannot delete conversation records while a Run is active or an external tool outcome remains unresolved",
    );
}

export function preserveChatModelPart(
  saved: Prisma.JsonValue,
  parts: Array<Record<string, unknown>>,
) {
  const modelPart = Array.isArray(saved)
    ? saved.find(
        (part) =>
          part &&
          typeof part === "object" &&
          !Array.isArray(part) &&
          part.type === "data-model",
      )
    : undefined;
  return modelPart && !parts.some((part) => part.type === "data-model")
    ? [modelPart, ...parts]
    : parts;
}

function messageTitle(parts: Array<Record<string, unknown>>): string | null {
  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join(" ")
    .trim()
    .replace(/\s+/g, " ");
  return text ? text.slice(0, 80) : null;
}
