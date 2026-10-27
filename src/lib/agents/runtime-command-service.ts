import "server-only";
import { randomUUID } from "node:crypto";
import {
  runNativeEntry,
  nativeEntryResult,
  nativeEntryRuntimeParts,
} from "@/lib/a2a/ingress";
import type { EntryIdentity } from "@/lib/a2a/entry-policy";
import type { TaskGrant } from "@/lib/a2a/principal";
import {
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { db } from "@/lib/db";
import { ACTIVE } from "@/lib/a2a/model";
import { localOwnerKey, assertLocalActor } from "@/lib/a2a/local-policy";
import { assertEntryPolicy } from "@/lib/a2a/entry-policy";
import { isLocalGrant } from "@/lib/a2a/principal";
import { appendWorkSessionInput } from "@/lib/work/sessions";
import { startWorkOutput } from "@/lib/work/run-control";
import { kickWorkCoordinator } from "@/lib/work/coordinator";
import { getAgentForRun } from "./queries";
import { persistAgentPromptInvocation } from "./prompt-invocation";
import { resolvePinnedAgent } from "./revisions";
import {
  acquireConversationOperation,
  conversationOperationKey,
} from "./conversation-operations";
import { parseRuntimeCommand } from "./runtime-commands";

export class RuntimeCommandError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export async function executeRuntimeCommand(input: {
  workspaceId: string;
  agentId: string;
  conversationId: string;
  actorId?: string;
  line: string;
  sandboxId?: string;
  signal?: AbortSignal;
  entry?: Pick<EntryIdentity, "kind" | "channelId">;
  messageId?: string;
}) {
  const [liveAgent, scope] = await Promise.all([
    getAgentForRun(input.agentId, input.workspaceId),
    db.conversation.findFirst({
      where: {
        id: input.conversationId,
        agentId: input.agentId,
        agent: { workspaceId: input.workspaceId },
      },
      include: {
        workSession: true,
        publicApiConversation: { select: { id: true } },
        messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      },
    }),
  ]);
  if (!liveAgent || !scope || scope.publicApiConversation)
    throw new RuntimeCommandError("notFound", 404);
  if (
    liveAgent.runtimeKind !== "pi-sdk" ||
    liveAgent.retiredAt ||
    scope.legacyRevisionUnresolved ||
    !scope.agentRevisionId
  )
    throw new RuntimeCommandError(
      "Historical Agent sessions are read-only.",
      409,
    );
  const agent = await resolvePinnedAgent(liveAgent, scope.agentRevisionId);
  const kind = agent.runtimeKind;
  if (kind !== "pi-sdk")
    throw new RuntimeCommandError(
      "Historical Agent sessions are read-only.",
      409,
    );
  const parsed = parseRuntimeCommand(input.line, kind);
  if (!parsed || input.line.length > 2000)
    throw new RuntimeCommandError("invalidCommand");
  const release = acquireConversationOperation(
    conversationOperationKey(scope),
    parsed.name,
  );
  if (!release) throw new RuntimeCommandError("busy", 409);
  try {
    const conversation = await db.conversation.findUniqueOrThrow({
      where: { id: scope.id },
      include: {
        workSession: true,
        messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      },
    });
    const work = conversation.workSession;
    if (
      work &&
      [
        "queued",
        "running",
        "waiting_approval",
        "cancelling",
        "archived",
      ].includes(work.status)
    )
      throw new RuntimeCommandError("busy", 409);
    if (work) {
      const result = await appendWorkSessionInput(
        input.workspaceId,
        work.id,
        input.line,
      );
      if (!result.ok) throw new RuntimeCommandError("busy", 409);
      startWorkOutput(work.id);
      kickWorkCoordinator();
      return { kind: "queued" as const, workSessionId: work.id };
    }
    let sdkEntry: EntryIdentity = {
      ...input.entry,
      kind: input.entry?.kind ?? "chat",
      sourceId: conversation.id,
    };
    {
      const bindings = await db.a2AEntryBinding.findMany({
        where: {
          sourceId: conversation.id,
          context: { workspaceId: input.workspaceId, agentId: input.agentId },
        },
        include: { lastTask: true },
      });
      if (bindings.length) {
        if (!input.actorId) throw new RuntimeCommandError("notFound", 404);
        const actorId = input.actorId;
        const owned = bindings.filter((binding) => {
          const grant = binding.lastTask.grant as unknown as TaskGrant;
          return (
            isLocalGrant(grant) &&
            grant.actorId === input.actorId &&
            grant.workspaceId === input.workspaceId &&
            grant.agentId === input.agentId &&
            grant.ownerKey === binding.ownerKey &&
            (binding.ownerKey ===
              localOwnerKey(
                "entry",
                input.workspaceId,
                input.agentId,
                actorId,
                binding.kind,
                conversation.id,
              ) ||
              binding.ownerKey ===
                localOwnerKey(input.workspaceId, input.agentId, actorId))
          );
        });
        if (owned.length !== 1) throw new RuntimeCommandError("notFound", 404);
        const binding = owned[0];
        const grant = binding.lastTask.grant as unknown as TaskGrant;
        if (
          !isLocalGrant(grant) ||
          !grant.entryPolicy ||
          grant.entryPolicy.sourceId !== conversation.id ||
          grant.entryPolicy.kind !== binding.kind ||
          binding.lastTask.contextId !== binding.contextId
        )
          throw new RuntimeCommandError("notFound", 404);
        try {
          await assertLocalActor(db, input.workspaceId, input.actorId);
          await assertEntryPolicy(db, grant);
        } catch (error) {
          if (
            error instanceof TaskNotFoundError ||
            error instanceof UnsupportedOperationError
          )
            throw new RuntimeCommandError("notFound", 404);
          throw error;
        }
        if (
          await db.a2ATask.count({
            where: { contextId: binding.contextId, state: { in: ACTIVE } },
          })
        )
          throw new RuntimeCommandError("busy", 409);
        if (
          input.entry &&
          (input.entry.kind !== grant.entryPolicy.kind ||
            input.entry.channelId !== grant.entryPolicy.channelId)
        )
          throw new RuntimeCommandError("notFound", 404);
        sdkEntry = {
          kind: grant.entryPolicy.kind,
          sourceId: conversation.id,
          ...(grant.entryPolicy.channelId
            ? { channelId: grant.entryPolicy.channelId }
            : {}),
        };
      }
    }
    if (!input.actorId) throw new RuntimeCommandError("notFound", 404);
    // Transport deliveries need a stable receipt ID; authenticated conversation
    // commands generate their own ID even when reusing a channel-owned context.
    if (input.entry?.kind === "channel" && !input.messageId)
      throw new RuntimeCommandError("invalidCommand");
    try {
      const user = await db.message.create({
        data: {
          conversationId: conversation.id,
          role: "user",
          parts: [{ type: "text", text: input.line }],
        },
      });
      const result = await runNativeEntry({
        ...sdkEntry,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        actorId: input.actorId,
        messageId: input.messageId ?? randomUUID(),
        text: input.line,
        signal: input.signal,
        onPromptInvocation: (invocation) =>
          persistAgentPromptInvocation({
            conversationId: conversation.id,
            messageId: user.id,
            invocation,
          }),
      });
      const text = nativeEntryResult(result.task, result.path);
      input.signal?.throwIfAborted();
      await db.message.create({
        data: {
          conversationId: conversation.id,
          role: "assistant",
          parts: [
            { type: "text", text },
            ...nativeEntryRuntimeParts(result.task),
          ],
        },
      });
      return { kind: "output" as const, text };
    } catch (error) {
      if (error instanceof TaskNotFoundError)
        throw new RuntimeCommandError("notFound", 404);
      throw new RuntimeCommandError(
        error instanceof Error ? error.message : "The runtime command failed.",
        502,
      );
    }
  } finally {
    release();
  }
}
