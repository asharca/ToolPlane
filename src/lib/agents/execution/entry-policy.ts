import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { workSessionWorkingDirectory } from "@/lib/work/sessions";
import type { LocalA2AGrant } from "@/lib/a2a/principal";

type Tx = Prisma.TransactionClient;
export type EntryKind = "chat" | "work" | "channel" | "control" | "trigger";
export type EntryIdentity = {
  kind: EntryKind;
  sourceId: string;
  conversationId?: string;
  channelId?: string;
};
const missing = () => new TaskNotFoundError();
/** Never infer a platform user from a channel sender or workspace owner. */
export async function createEntryPolicy(
  tx: Tx,
  grant: Pick<LocalA2AGrant, "workspaceId" | "agentId" | "actorId">,
  source: EntryIdentity,
): Promise<NonNullable<LocalA2AGrant["entryPolicy"]>> {
  let authorization: unknown;
  let workingDirectory: string | undefined;
  if (source.kind === "work") {
    const work = await tx.workSession.findFirst({
      where: {
        id: source.sourceId,
        workspaceId: grant.workspaceId,
        agentId: grant.agentId,
        a2aActorId: grant.actorId,
      },
      select: {
        runtimeSnapshot: true,
        cancelRequestedAt: true,
        status: true,
        agentRevisionId: true,
        legacyRevisionUnresolved: true,
        runtimeKind: true,
      },
    });
    if (
      !work?.agentRevisionId ||
      work.legacyRevisionUnresolved ||
      work.runtimeKind !== "pi-sdk" ||
      work.cancelRequestedAt ||
      ["archived", "cancelling", "cancelled"].includes(work.status)
    )
      throw missing();
    workingDirectory = workSessionWorkingDirectory(work.runtimeSnapshot);
    authorization = [work.agentRevisionId, work.runtimeSnapshot, grant.actorId];
  } else {
    if (source.kind === "trigger") {
      const trigger = await tx.agentTrigger.findFirst({
        where: {
          id: source.sourceId,
          agentId: grant.agentId,
          workspaceId: grant.workspaceId,
          actorId: grant.actorId,
        },
      });
      if (!trigger || !source.conversationId) throw missing();
    }
    const conversation = await tx.conversation.findFirst({
      where: {
        id: source.kind === "trigger" ? source.conversationId : source.sourceId,
        agent: { workspaceId: grant.workspaceId },
        agentId: grant.agentId,
      },
      select: {
        runtimeSessionKey: true,
        agentRevisionId: true,
        legacyRevisionUnresolved: true,
        workSession: { select: { id: true } },
        publicApiConversation: { select: { id: true } },
      },
    });
    if (
      !conversation?.agentRevisionId ||
      conversation.legacyRevisionUnresolved ||
      conversation.workSession ||
      conversation.publicApiConversation
    )
      throw missing();
    if (source.kind === "channel") {
      if (
        !source.channelId ||
        !conversation.runtimeSessionKey?.startsWith(
          `channel:${source.channelId}:`,
        )
      )
        throw missing();
      const channel = await tx.agentChannelConnection.findFirst({
        where: {
          id: source.channelId,
          workspaceId: grant.workspaceId,
          agentId: grant.agentId,
          a2aActorId: grant.actorId,
          status: { in: ["running", "starting", "waiting_callback"] },
        },
        select: {
          agentId: true,
          sandboxId: true,
          platform: true,
          config: true,
          credentials: true,
          inboundTokenHash: true,
          a2aActorId: true,
        },
      });
      if (!channel)
        throw new UnsupportedOperationError(
          "Channel execution identity or active binding is unavailable.",
        );
      // Store a digest, not a secret-bearing configuration snapshot.
      authorization = [
        conversation.agentRevisionId,
        channel,
        conversation.runtimeSessionKey,
      ];
    } else {
      if (conversation.runtimeSessionKey?.startsWith("channel:"))
        throw missing();
      authorization = [
        conversation.agentRevisionId,
        conversation.runtimeSessionKey,
        grant.actorId,
      ];
    }
  }
  return {
    ...source,
    sourceAgentId: grant.agentId,
    workingDirectory,
    binding: createHash("sha256")
      .update(
        JSON.stringify([
          grant.workspaceId,
          grant.agentId,
          source,
          authorization,
        ]),
      )
      .digest("hex"),
  };
}
export async function assertEntryPolicy(tx: Tx, grant: LocalA2AGrant) {
  const entry = grant.entryPolicy;
  if (!entry) return;
  const current = await createEntryPolicy(
    tx,
    { ...grant, agentId: entry.sourceAgentId },
    {
      kind: entry.kind,
      sourceId: entry.sourceId,
      ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
      ...(entry.channelId ? { channelId: entry.channelId } : {}),
    },
  );
  if (
    current.binding !== entry.binding ||
    current.workingDirectory !== entry.workingDirectory
  )
    throw missing();
}
