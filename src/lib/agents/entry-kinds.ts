import type { Prisma } from "@prisma/client";

type EntrySource = "conversation" | "workSession";
type EntryDefinition = { source: EntrySource; hasSeparateGrantSource?: true };

/** How a persisted A2AEntryBinding.sourceId identifies its conversation. */
const ENTRY_SOURCES = {
  chat: { source: "conversation" },
  work: { source: "workSession" },
  channel: { source: "conversation" },
  control: { source: "conversation" },
  // The grant retains the trigger ID separately from the session binding key.
  trigger: { source: "conversation", hasSeparateGrantSource: true },
} as const satisfies Record<string, EntryDefinition>;

export type EntryKind = keyof typeof ENTRY_SOURCES;
export const ENTRY_KINDS: readonly EntryKind[] = Object.keys(
  ENTRY_SOURCES,
) as EntryKind[];

const conversationKinds = ENTRY_KINDS.filter(
  (kind) => ENTRY_SOURCES[kind].source === "conversation",
);
const workKinds = ENTRY_KINDS.filter(
  (kind) => ENTRY_SOURCES[kind].source === "workSession",
);

type EntryBinding = { kind: string; sourceId: string };
type ConversationIdentity = { conversation: string; workSession?: string };

function entryDefinition(kind: string): EntryDefinition | undefined {
  return Object.hasOwn(ENTRY_SOURCES, kind)
    ? ENTRY_SOURCES[kind as EntryKind]
    : undefined;
}

/** Resolve either a persisted binding or its originating grant identity. */
export async function entryConversationId(
  tx: Pick<Prisma.TransactionClient, "workSession">,
  scope: { workspaceId: string; agentId: string },
  entry: EntryBinding & { conversationId?: string },
): Promise<string | undefined> {
  const definition = entryDefinition(entry.kind);
  if (!definition) return undefined;
  const source = definition.source;
  switch (source) {
    case "conversation":
      return definition.hasSeparateGrantSource
        ? (entry.conversationId ?? entry.sourceId)
        : entry.sourceId;
    case "workSession": {
      const work = await tx.workSession.findFirst({
        where: {
          id: entry.sourceId,
          workspaceId: scope.workspaceId,
          agentId: scope.agentId,
        },
        select: { conversationId: true },
      });
      return work?.conversationId ?? undefined;
    }
    default:
      return source satisfies never;
  }
}

export async function entryConversationIds(
  tx: Pick<Prisma.TransactionClient, "workSession">,
  scope: { workspaceId: string; agentId: string },
  entries: readonly EntryBinding[],
) {
  const ids = new Set<string>();
  for (const entry of entries) {
    const id = await entryConversationId(tx, scope, entry);
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

export function conversationEntryFilter(
  identity: ConversationIdentity,
): Prisma.A2AEntryBindingWhereInput {
  const direct = {
    kind: { in: conversationKinds },
    sourceId: identity.conversation,
  };
  return identity.workSession === undefined
    ? direct
    : {
        OR: [
          direct,
          { kind: { in: workKinds }, sourceId: identity.workSession },
        ],
      };
}

export function matchesConversationEntry(
  entry: EntryBinding,
  identity: ConversationIdentity,
): boolean {
  const source = entryDefinition(entry.kind)?.source;
  return source !== undefined && identity[source] === entry.sourceId;
}
