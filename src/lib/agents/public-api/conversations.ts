import "server-only";
import type { AgentApiPrincipal } from "@/lib/agents/public-api/auth";
import { db } from "@/lib/db";
import { AgentApiError } from "@/lib/agents/public-api/errors";
import { AGENT_API_MAX_TRANSCRIPT_CHARACTERS } from "@/lib/agents/public-api/body";

export const AGENT_API_DEFAULT_TRANSCRIPT_PAGE_SIZE = 20;
export const AGENT_API_MAX_TRANSCRIPT_PAGE_SIZE = 100;

function textFromParts(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("");
}

export async function getAgentConversationForPrincipal(
  principal: AgentApiPrincipal,
  publicId: string,
  options: { limit?: number; after?: string | null } = {},
) {
  const wrapper = await db.agentPublicConversation.findFirst({
    where: {
      publicId,
      endpointId: principal.endpointId,
      clientId: principal.clientId,
      ...(principal.subjectHash ? { subjectHash: principal.subjectHash } : {}),
      deletingAt: null,
    },
    select: {
      publicId: true,
      createdAt: true,
      revision: { select: { version: true } },
      conversationId: true,
    },
  });
  if (!wrapper) return null;
  const limit = Math.min(
    AGENT_API_MAX_TRANSCRIPT_PAGE_SIZE,
    Math.max(1, options.limit ?? AGENT_API_DEFAULT_TRANSCRIPT_PAGE_SIZE),
  );
  const after = options.after?.trim() || null;
  if (after) {
    const cursor = await db.message.findFirst({
      where: { id: after, conversationId: wrapper.conversationId },
      select: { id: true },
    });
    if (!cursor)
      throw new AgentApiError(
        "invalid_request",
        "The conversation cursor is invalid.",
        400,
      );
  }
  const rows = await db.message.findMany({
    where: {
      conversationId: wrapper.conversationId,
      role: { in: ["user", "assistant"] },
    },
    orderBy: [{ sequence: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    take: limit + 1,
    select: { id: true, role: true, createdAt: true, textCharacters: true },
  });
  const selectedRows: typeof rows = [];
  let selectedCharacters = 0;
  for (const row of rows.slice(0, limit)) {
    if (
      selectedRows.length &&
      selectedCharacters + row.textCharacters >
        AGENT_API_MAX_TRANSCRIPT_CHARACTERS
    )
      break;
    selectedCharacters += row.textCharacters;
    selectedRows.push(row);
  }
  const fullRows = selectedRows.length
    ? await db.message.findMany({
        where: {
          conversationId: wrapper.conversationId,
          id: { in: selectedRows.map((row) => row.id) },
        },
        select: { id: true, parts: true },
      })
    : [];
  const partsById = new Map(fullRows.map((row) => [row.id, row.parts]));
  const messages: Array<{
    id: string;
    role: string;
    content: string;
    created_at: number;
  }> = [];
  for (const message of selectedRows) {
    const text = textFromParts(partsById.get(message.id));
    if (!text) continue;
    messages.push({
      id: message.id,
      role: message.role,
      content: text.slice(0, AGENT_API_MAX_TRANSCRIPT_CHARACTERS),
      created_at: Math.floor(message.createdAt.getTime() / 1_000),
    });
  }
  const hasMore = rows.length > selectedRows.length;
  return {
    id: wrapper.publicId,
    object: "agent.conversation",
    endpoint_id: principal.endpointPublicId,
    endpoint_revision: wrapper.revision.version,
    created_at: Math.floor(wrapper.createdAt.getTime() / 1_000),
    messages,
    has_more: hasMore,
    next_cursor: hasMore ? (messages.at(-1)?.id ?? after) : null,
  };
}
