import "server-only";
import type { Prisma } from "@prisma/client";
import {
  CLEAR_CONTEXT_PART,
  COMPACTION_PART,
  compactionSummaryText,
  hasNativeConversationHistory,
  isConversationControl,
  messageCompaction,
  type ContextMessage,
} from "@/lib/agents/conversation-context";
import { db } from "@/lib/db";

const newestFirst = [
  { createdAt: "desc" },
  { id: "desc" },
] satisfies Prisma.MessageOrderByWithRelationInput[];
const select = { id: true, role: true, parts: true, createdAt: true } as const;
type SelectedMessage = Prisma.MessageGetPayload<{ select: typeof select }>;
type Position = { createdAt: Date; id: string };
function after({ createdAt, id }: Position): Prisma.MessageWhereInput {
  return {
    OR: [{ createdAt: { gt: createdAt } }, { createdAt, id: { gt: id } }],
  };
}

/** Pi restores its own transcript. Only the last prompt (and its predecessor for commands) crosses the sandbox boundary. */
export async function workTurnContext(
  conversationId: string,
  messageLimit: 1 | 2,
  checkHistory: boolean,
) {
  const where = { conversationId, supersededAt: null };
  const clear = await db.message.findFirst({
    where: {
      ...where,
      role: { not: "user" },
      parts: { array_contains: [{ type: CLEAR_CONTEXT_PART }] },
    },
    orderBy: newestFirst,
    select: { id: true, createdAt: true },
  });
  let boundary: Position | null = clear;
  let seed: ContextMessage | undefined;
  let cursor: string | undefined;
  // Validate stored markers with the same parser used by transcript rendering.
  for (;;) {
    const marker: SelectedMessage | null = await db.message.findFirst({
      where: {
        ...where,
        ...(clear && after(clear)),
        role: "system",
        parts: { array_contains: [{ type: COMPACTION_PART }] },
      },
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: newestFirst,
      select,
    });
    if (!marker) break;
    const compaction = messageCompaction(marker);
    if (!compaction) {
      cursor = marker.id;
      continue;
    }
    const cut = await db.message.findFirst({
      where: {
        ...where,
        ...(clear && after(clear)),
        id: compaction.boundaryId,
      },
      select: { id: true, createdAt: true },
    });
    if (cut) {
      boundary = cut;
      seed = {
        id: `compaction:${cut.id}`,
        role: "user",
        parts: [
          { type: "text", text: compactionSummaryText(compaction.summary) },
        ],
      };
    }
    break;
  }
  cursor = undefined;
  const messages: ContextMessage[] = [];
  let nativeHistory = false;
  while (messages.length < messageLimit || (checkHistory && !nativeHistory)) {
    const take = cursor ? 16 : messageLimit;
    const page: SelectedMessage[] = await db.message.findMany({
      where: { ...where, ...(boundary && after(boundary)) },
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: newestFirst,
      take,
      select,
    });
    for (const message of page) {
      if (messageCompaction(message) || isConversationControl(message))
        continue;
      if (messages.length < messageLimit) messages.push(message);
      if (checkHistory && !nativeHistory)
        nativeHistory = hasNativeConversationHistory([message]);
    }
    if (page.length < take) break;
    cursor = page[page.length - 1].id;
  }
  if (messages.length < messageLimit && seed) messages.push(seed);
  return { messages: messages.reverse(), nativeHistory };
}
