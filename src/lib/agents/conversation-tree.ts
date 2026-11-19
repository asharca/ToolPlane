import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { TERMINAL } from "@/lib/a2a/model";
import { assertLocalActor } from "@/lib/a2a/local-policy";
import { getAgentForRun } from "./queries";
import { resolvePinnedAgent } from "./revisions";
import {
  acquireConversationOperation,
  conversationOperationKey,
} from "./conversation-operations";
import {
  AgentExecutionBusyError,
  withAgentDraftLease,
} from "./agent-execution-gate";
import {
  ensureAgentConversationSandbox,
  deleteAgentConversationSandboxes,
} from "./conversation-sandbox";
import { forkWorkPiSession } from "./sandbox-runtime";
import { workSessionWorkingDirectory } from "@/lib/work/sessions";
import {
  insertWorkSession,
  updateWorkSessionStatus,
} from "@/lib/work/lifecycle";
import {
  canTransitionWorkSession,
  isWorkSessionReadOnly,
} from "@/lib/work/state-machine";
import { kickWorkCoordinator } from "@/lib/work/coordinator";
import { startWorkOutput } from "@/lib/work/run-control";
import { logSystemEvent } from "@/lib/observability/system";
import { AGENT_PROMPT_INVOCATION_PART } from "./prompt-invocation";

export class ConversationTreeError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
  }
}

const contextOnly = {
  contextOnly: true,
  filesRewound: false,
  externalEffectsRewound: false,
} as const;

/** Only native Work owns a mutable console transcript. Never infer Pi IDs from text/order. */
export async function mutateWorkConversationTree(input: {
  workspaceId: string;
  agentId: string;
  conversationId: string;
  actorId: string;
  action: "edit" | "retry" | "branch";
  messageId?: string;
  text?: string;
  signal?: AbortSignal;
}) {
  const agent = await getAgentForRun(input.agentId, input.workspaceId);
  if (!agent) throw new ConversationTreeError("notFound", 404);
  await assertLocalActor(db, input.workspaceId, input.actorId);
  const scope = await db.conversation.findFirst({
    where: {
      id: input.conversationId,
      agentId: input.agentId,
      agent: { workspaceId: input.workspaceId },
    },
    include: { workSession: true, publicApiConversation: true },
  });
  if (!scope) throw new ConversationTreeError("notFound", 404);
  const work = scope.workSession;
  if (
    !work ||
    scope.publicApiConversation ||
    scope.triggerId ||
    scope.title?.startsWith("msg:") ||
    scope.runtimeSessionKey?.startsWith("channel:")
  )
    throw new ConversationTreeError("conversationTreeUnsupported");
  if (
    agent.runtimeKind !== "pi-sdk" ||
    agent.retiredAt ||
    scope.legacyRevisionUnresolved ||
    !scope.agentRevisionId ||
    work.runtimeKind !== "pi-sdk" ||
    work.legacyRevisionUnresolved ||
    work.agentRevisionId !== scope.agentRevisionId ||
    isWorkSessionReadOnly(work.status)
  )
    throw new ConversationTreeError("readOnly");
  try {
    await resolvePinnedAgent(agent, scope.agentRevisionId);
  } catch {
    throw new ConversationTreeError("readOnly");
  }
  const release = acquireConversationOperation(
    conversationOperationKey(scope),
    input.action,
  );
  if (!release) throw new ConversationTreeError("busy");
  let createdConversationId: string | undefined;
  try {
    return await withAgentDraftLease(input.agentId, async () => {
      const prepared = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "WorkSession" WHERE id=${work.id} FOR UPDATE`;
        const current = await tx.workSession.findFirst({
          where: {
            id: work.id,
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            conversationId: scope.id,
          },
          include: {
            conversation: {
              include: {
                messages: {
                  where: { supersededAt: null },
                  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                },
                piPackageSet: { include: { packages: true } },
              },
            },
          },
        });
        if (!current) throw new ConversationTreeError("notFound", 404);
        if (
          current.legacyRevisionUnresolved ||
          isWorkSessionReadOnly(current.status) ||
          current.agentRevisionId !== scope.agentRevisionId ||
          current.conversation.legacyRevisionUnresolved ||
          current.conversation.agentRevisionId !== scope.agentRevisionId
        )
          throw new ConversationTreeError("readOnly");
        if (!canTransitionWorkSession(current.status, "queued"))
          throw new ConversationTreeError("busy");
        const bindings = await tx.a2AEntryBinding.findMany({
          where: {
            sourceId: { in: [scope.id, work.id] },
            context: { workspaceId: input.workspaceId, agentId: input.agentId },
          },
          select: { kind: true, contextId: true },
        });
        if (bindings.some((binding) => binding.kind !== "work"))
          throw new ConversationTreeError("conversationTreeUnsupported");
        const contextIds = bindings.map((binding) => binding.contextId);
        const roots = await tx.a2ATask.findMany({
          where: { contextId: { in: contextIds } },
          select: { id: true, rootTaskId: true },
        });
        if (
          await tx.a2ATask.count({
            where: {
              OR: [
                { contextId: { in: contextIds } },
                {
                  rootTaskId: {
                    in: [
                      ...new Set(
                        roots.map((task) => task.rootTaskId ?? task.id),
                      ),
                    ],
                  },
                },
              ],
              state: { notIn: TERMINAL },
            },
          })
        )
          throw new ConversationTreeError("busy");
        const messages = current.conversation.messages;
        const target =
          input.action === "retry"
            ? messages.findLast((message) => message.role === "user")
            : messages.find((message) => message.id === input.messageId);
        if (!target) throw new ConversationTreeError("messageNotFound", 404);
        if (input.action !== "branch" && target.role !== "user")
          throw new ConversationTreeError("userMessageRequired", 400);
        if (!target.piEntryId)
          throw new ConversationTreeError("piEntryMappingMissing");
        const index = messages.findIndex((message) => message.id === target.id);
        if (input.action === "branch")
          return {
            kind: "branch" as const,
            current,
            target,
            entryId: target.piEntryId,
            prefix: messages.slice(0, index + 1),
          };
        const text = input.action === "edit" ? input.text?.trim() : undefined;
        if (input.action === "edit" && (!text || text.length > 20_000))
          throw new ConversationTreeError("invalidText", 400);
        // Retry preserves authored parts (including references/attachments and model selection).
        // Edit replaces only authored text while retaining non-text metadata/attachments.
        const authoredParts = Array.isArray(target.parts)
          ? target.parts.filter(
              (part) =>
                !(
                  part &&
                  typeof part === "object" &&
                  !Array.isArray(part) &&
                  part.type === AGENT_PROMPT_INVOCATION_PART
                ),
            )
          : [];
        const parts =
          input.action === "retry"
            ? authoredParts
            : [
                { type: "text", text },
                ...authoredParts.filter(
                  (part) =>
                    part &&
                    typeof part === "object" &&
                    !Array.isArray(part) &&
                    part.type !== "text",
                ),
              ];
        const replacement = await tx.message.create({
          data: {
            id: randomUUID(),
            conversationId: scope.id,
            role: "user",
            parts: parts as Prisma.InputJsonValue,
            piRewindEntryId: target.piEntryId,
            textCharacters: text?.length ?? target.textCharacters,
            createdAt: new Date(
              Math.max(
                Date.now(),
                (messages.at(-1)?.createdAt.getTime() ?? 0) + 1,
              ),
            ),
          },
        });
        await tx.message.updateMany({
          where: {
            conversationId: scope.id,
            id: { in: messages.slice(index).map((message) => message.id) },
            supersededAt: null,
          },
          data: { supersededAt: new Date(), supersededById: replacement.id },
        });
        const queued = await updateWorkSessionStatus(
          tx,
          {
            id: work.id,
            workspaceId: input.workspaceId,
            status: current.status,
          },
          {
            status: "queued",
            a2aActorId: input.actorId,
            result: null,
            artifacts: [],
            error: null,
            waitingQuestion: null,
            completedAt: null,
            cancelRequestedAt: null,
            uiProjection: {},
            uiLease: null,
          },
        );
        if (!queued.count) throw new ConversationTreeError("busy");
        return { kind: "replay" as const, replacement };
      });
      if (prepared.kind === "replay") {
        startWorkOutput(work.id);
        kickWorkCoordinator();
        return {
          ...contextOnly,
          kind: "queued" as const,
          conversationId: scope.id,
          workSessionId: work.id,
          messageId: prepared.replacement.id,
        };
      }
      const { current, target, prefix } = prepared;
      const source = await ensureAgentConversationSandbox({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        conversationId: scope.id,
        signal: input.signal,
      });
      const created = await db.$transaction(async (tx) => {
        const conversation = await tx.conversation.create({
          data: {
            agentId: input.agentId,
            agentRevisionId: scope.agentRevisionId,
            legacyRevisionUnresolved: false,
            title: current.conversation.title,
            reasoningEffort: current.conversation.reasoningEffort,
            modelOverride: current.conversation.modelOverride ?? undefined,
            branchedFromConversationId: scope.id,
            branchedFromMessageId: target.id,
          },
        });
        if (current.conversation.piPackageSet)
          await tx.piSessionPackageSet.create({
            data: {
              conversationId: conversation.id,
              legacy: current.conversation.piPackageSet.legacy,
              packages: {
                create: current.conversation.piPackageSet.packages.map(
                  (pkg) => ({
                    marketInstallId: pkg.marketInstallId,
                    releaseId: pkg.releaseId,
                    checksum: pkg.checksum,
                    resourceMap: pkg.resourceMap as Prisma.InputJsonValue,
                  }),
                ),
              },
            },
          });
        await tx.message.createMany({
          data: prefix.map((message) => ({
            conversationId: conversation.id,
            role: message.role,
            parts: message.parts as Prisma.InputJsonValue,
            textCharacters: message.textCharacters,
            sequence: message.sequence,
            createdAt: message.createdAt,
            piEntryId: message.piEntryId,
            piParentEntryId: message.piParentEntryId,
            piTurnLeafId: message.piTurnLeafId,
          })),
        });
        const branchedWork = await insertWorkSession(tx, "forking", {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          agentRevisionId: scope.agentRevisionId,
          legacyRevisionUnresolved: false,
          conversationId: conversation.id,
          sandboxId: current.sandboxId,
          a2aActorId: input.actorId,
          title: current.title,
          task: current.task,
          acceptanceCriteria: current.acceptanceCriteria,
          runtimeKind: "pi-sdk",
          runtimeSnapshot: current.runtimeSnapshot ?? undefined,
        });
        return {
          conversationId: conversation.id,
          workSessionId: branchedWork.id,
        };
      });
      createdConversationId = created.conversationId;
      const destination = await ensureAgentConversationSandbox({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        conversationId: created.conversationId,
        signal: input.signal,
      });
      await forkWorkPiSession({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        source,
        target: destination,
        sourceConversationId: scope.id,
        targetConversationId: created.conversationId,
        entryId: prepared.entryId,
        workingDirectory: workSessionWorkingDirectory(current.runtimeSnapshot),
        signal: input.signal,
      });
      const ready = await updateWorkSessionStatus(
        db,
        {
          id: created.workSessionId,
          workspaceId: input.workspaceId,
          status: "forking",
        },
        { status: "idle" },
      );
      if (!ready.count) throw new ConversationTreeError("busy");
      createdConversationId = undefined;
      return {
        ...contextOnly,
        kind: "branched" as const,
        ...created,
        branchedFromConversationId: scope.id,
        branchedFromMessageId: target.id,
      };
    });
  } catch (error) {
    if (createdConversationId) {
      try {
        await deleteAgentConversationSandboxes({
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          conversationId: createdConversationId,
        });
        await db.conversation.deleteMany({
          where: {
            id: createdConversationId,
            agentId: input.agentId,
            agent: { workspaceId: input.workspaceId },
          },
        });
      } catch (cleanupError) {
        logSystemEvent("agents.conversation.branch_cleanup_failed", {
          domain: "agent",
          error: cleanupError,
          conversationId: createdConversationId,
        });
      }
    }
    if (error instanceof AgentExecutionBusyError)
      throw new ConversationTreeError("busy");
    throw error;
  } finally {
    release();
  }
}
