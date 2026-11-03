import { nativeUiView } from "./native-ui";
import "server-only";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { SendMessageRequest, Task, TaskState, Role } from "@a2a-js/sdk";
import {
  RequestMalformedError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { z } from "zod";
import {
  COMMAND_RESULT_PART,
  RUNTIME_COMMANDS_PART,
  RUNTIME_USAGE_PART,
  RuntimeCommandsSchema,
} from "@/lib/agents/runtime-commands";
import type {
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeUsage,
} from "@/lib/agents/runtime-commands";
import type {
  AgentPromptInvocation,
  SandboxRuntimeActivity,
} from "@/lib/agents/sandbox-runtime";
import type { AgentModelOverride } from "@/lib/agents/chat-body";
import { resolveAgentModelOverride } from "@/lib/agents/turn-model";
import { AGENT_TURN_MODEL_PART } from "@/lib/agents/turn-model";
import { db } from "@/lib/db";
import { requireAgentRevision } from "@/lib/agents/revisions";
import { assertRuntimeOwner } from "@/lib/runtime/ownership-state";
import { recordEvent } from "@/lib/observability/events";
import {
  createLocalEntryGrant,
  assertLocalGrant,
  localOwnerKey,
} from "@/lib/a2a/local-policy";
import {
  createEntryPolicy,
  type EntryIdentity,
} from "@/lib/agents/execution/entry-policy";
import {
  submitTaskInTransaction,
  getTaskRow,
  requestWorkEntryCancellation,
  taskScope,
} from "@/lib/a2a/store";
import { settled, terminal, A2A_LIMITS } from "@/lib/a2a/model";
import { refreshTaskStorage } from "@/lib/a2a/quotas";
import { wakeAgentWorker } from "@/lib/agents/execution/worker";

export type EntryMessage = { id?: string; role: string; parts: unknown };
export type AgentEntryInput = EntryIdentity & {
  workspaceId: string;
  agentId: string;
  actorId: string;
  messageId: string;
  text: string;
  modelOverride?: AgentModelOverride;
};
const hash = (data: unknown) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
/** Only the latest explicit text becomes new work. Old tool calls are never replayed. */
export function latestEntryText(message: EntryMessage | undefined): string {
  if (message?.role !== "user" || !Array.isArray(message.parts))
    throw new RequestMalformedError("A user message is required.");
  const parts = message.parts as Array<{ type?: string; text?: unknown }>;
  if (
    !parts.length ||
    parts.some((part) => part?.type !== "text" || typeof part.text !== "string")
  ) {
    throw new UnsupportedOperationError(
      "Native ingress currently accepts text only; attachments must be handled explicitly, not silently discarded.",
    );
  }
  const text = parts
    .map((p) => p.text)
    .join("\n")
    .trim();
  if (!text || text.length > A2A_LIMITS.inputCharacters)
    throw new RequestMalformedError(
      "The native task input is empty or too large.",
    );
  return text;
}
export async function submitAgentEntry(
  input: AgentEntryInput,
  wake: () => void = wakeAgentWorker,
) {
  const started = performance.now();
  assertRuntimeOwner();
  if (
    !input.actorId ||
    !input.sourceId ||
    input.sourceId.length > 200 ||
    !input.messageId ||
    input.messageId.length > 240 ||
    !input.text.trim() ||
    input.text.length > A2A_LIMITS.inputCharacters
  )
    throw new RequestMalformedError("Invalid native entry request.");
  const accepted = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.workspaceId} FOR UPDATE`;
    const scope = {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      actorId: input.actorId,
    };
    const policy = await createEntryPolicy(tx, scope, {
      kind: input.kind,
      sourceId: input.sourceId,
      ...(input.channelId ? { channelId: input.channelId } : {}),
    });
    const grant = await createLocalEntryGrant(
      tx,
      input.workspaceId,
      input.agentId,
      input.actorId,
      policy,
    );
    await assertLocalGrant(grant, tx);
    if (input.modelOverride) {
      if (input.kind !== "chat" && input.kind !== "work")
        throw new RequestMalformedError("modelOverrideInvalid");
      await resolveAgentModelOverride(
        input.workspaceId,
        input.modelOverride,
        (await requireAgentRevision(tx, grant.agentId, grant.agentRevisionId))
          .config.runtimeKind,
        tx,
      );
      grant.modelOverride = input.modelOverride;
    }
    const key = {
      ownerKey: grant.ownerKey,
      kind: input.kind,
      sourceId: input.sourceId,
    };
    const inputHash = hash(
      input.modelOverride ? [input.text, input.modelOverride] : [input.text],
    );
    let binding = await tx.a2AEntryBinding.findUnique({
      where: { ownerKey_kind_sourceId: key },
      include: { lastTask: true },
    });
    if (!binding) {
      const previousKey = {
        ...key,
        ownerKey: localOwnerKey(
          input.workspaceId,
          input.agentId,
          input.actorId,
        ),
      };
      const legacy = await tx.a2AEntryBinding.findUnique({
        where: { ownerKey_kind_sourceId: previousKey },
      });
      if (legacy) {
        const receipt = await tx.a2AEntryReceipt.findUnique({
          where: {
            bindingId_messageId: {
              bindingId: legacy.id,
              messageId: input.messageId,
            },
          },
          include: { task: true },
        });
        if (receipt) {
          if (receipt.inputHash !== inputHash)
            throw new RequestMalformedError(
              "The entry message ID was reused with different content.",
            );
          const previous = receipt.task.grant as unknown as typeof grant;
          if (
            !previous.entryPolicy ||
            previous.entryPolicy.kind !== policy.kind ||
            previous.entryPolicy.sourceId !== policy.sourceId ||
            previous.entryPolicy.binding !== policy.binding ||
            previous.agentId !== grant.agentId ||
            previous.actorId !== grant.actorId ||
            previous.ownerKey !== previousKey.ownerKey
          )
            throw new TaskNotFoundError();
          await assertLocalGrant(previous, tx);
          if (
            !(await tx.a2AContext.count({
              where: {
                id: receipt.task.contextId,
                ...taskScope(previous),
                expiresAt: { gt: new Date() },
              },
            }))
          )
            throw new TaskNotFoundError();
          return { row: receipt.task, grant: previous, replay: true };
        }
      }
    }
    const replay = binding
      ? await tx.a2AEntryReceipt.findUnique({
          where: {
            bindingId_messageId: {
              bindingId: binding.id,
              messageId: input.messageId,
            },
          },
          include: { task: true },
        })
      : null;
    if (replay) {
      if (replay.inputHash !== inputHash)
        throw new RequestMalformedError(
          "The entry message ID was reused with different content.",
        );
      if (
        !(await tx.a2AContext.count({
          where: {
            id: replay.task.contextId,
            ownerKey: grant.ownerKey,
            expiresAt: { gt: new Date() },
          },
        }))
      )
        throw new TaskNotFoundError();
      return { row: replay.task, grant, replay: true };
    }
    const previous = binding?.lastTask;
    if (previous && !settled(previous.state))
      throw new UnsupportedOperationError(
        "The previous native task is still active. Query or explicitly cancel it.",
      );
    if (previous?.state === TaskState.TASK_STATE_AUTH_REQUIRED)
      throw new UnsupportedOperationError(
        "A message cannot approve an authorization request.",
      );
    // No copied model/system/tool history: a first migrated conversation starts a new native context.
    // Existing records remain readable. Subsequent turns reuse the native context only.
    const request = SendMessageRequest.fromJSON({
      message: {
        messageId: `entry-${hash([input.kind, input.sourceId, input.messageId])}`,
        role: "ROLE_USER",
        parts: [{ text: input.text }],
        ...(previous
          ? {
              contextId: previous.contextId,
              ...(previous.state === TaskState.TASK_STATE_INPUT_REQUIRED
                ? { taskId: previous.id }
                : { referenceTaskIds: [previous.id] }),
            }
          : {}),
      },
      configuration: { returnImmediately: true },
    });
    const row = await submitTaskInTransaction(tx, grant, request);
    binding = await tx.a2AEntryBinding.upsert({
      where: { ownerKey_kind_sourceId: key },
      create: { ...key, contextId: row.contextId, lastTaskId: row.id },
      update: { lastTaskId: row.id },
      include: { lastTask: true },
    });
    await tx.a2AEntryReceipt.create({
      data: {
        bindingId: binding.id,
        messageId: input.messageId,
        inputHash,
        taskId: row.id,
      },
    });
    await refreshTaskStorage(tx, row.id);
    return { row, grant, replay: false };
  });
  const { row } = accepted;
  await recordEvent({
    domain: "agent",
    eventName: "agent.execution.accepted",
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    actorId: input.actorId,
    conversationId: input.kind === "work" ? undefined : input.sourceId,
    outcome: "success",
    durationMs: performance.now() - started,
    attributes: {
      taskId: row.id,
      contextId: row.contextId,
      entryKind: input.kind,
      replay: accepted.replay,
    },
  });
  wake();
  return accepted;
}
/** Each entry owns its presentation; disconnect only detaches the observer. */
export async function runAgentEntry(
  input: AgentEntryInput & {
    signal?: AbortSignal;
    onAccepted?: (task: Task, path: string) => void | Promise<void>;
    onUiRequired?: (path: string) => void | Promise<void>;
    onPromptInvocation?: (
      invocation: AgentPromptInvocation,
    ) => void | Promise<void>;
    onActivity?: (activity: SandboxRuntimeActivity) => void | Promise<void>;
  },
) {
  const accepted = await submitAgentEntry(input);
  const promptMessageId = SendMessageRequest.fromJSON(accepted.row.request)
    .message?.messageId;
  if (!promptMessageId) throw new TaskNotFoundError();
  const workspace = await db.workspace.findUniqueOrThrow({
    where: { id: input.workspaceId },
    select: { slug: true },
  });
  const query = new URLSearchParams({ agent: input.agentId });
  query.set(input.kind === "work" ? "w" : "c", input.sourceId);
  const path = `/app/${encodeURIComponent(workspace.slug)}/work?${query}`;
  await input.onAccepted?.(Task.fromJSON(accepted.row.snapshot), path);
  const observedPrompts = new Set<string>();
  const notifiedUiRequests = new Set<string>();
  const observedActivities = new Map<string, string>();
  const observeActivities = async (projection: unknown) => {
    if (!input.onActivity) return;
    for (const activity of nativeUiView(projection).activities) {
      const key = `${activity.source.subagentId}:${activity.type}:${activity.toolCallId ?? ""}`;
      const value = JSON.stringify(activity);
      if (observedActivities.get(key) === value) continue;
      observedActivities.set(key, value);
      await input.onActivity(activity);
    }
  };
  const observePrompts = async (task: Task) => {
    if (!input.onPromptInvocation) return;
    for (const invocation of agentEntryPromptInvocations(
      task,
      promptMessageId,
    )) {
      const key = JSON.stringify(invocation);
      if (observedPrompts.has(key)) continue;
      observedPrompts.add(key);
      await input.onPromptInvocation(invocation);
    }
  };
  try {
    while (true) {
      input.signal?.throwIfAborted();
      await assertLocalGrant(accepted.grant);
      const row = await getTaskRow(accepted.grant, accepted.row.id);
      const task = Task.fromJSON(row.snapshot);
      await observeActivities(row.uiProjection);
      await observePrompts(task);
      if (settled(row.state)) return { task, path };
      if (input.onUiRequired && row.leaseToken) {
        const requests = nativeUiView(
          row.uiProjection,
          row.leaseToken,
          row.phase === "executing",
        ).uiRequests;
        const unseen = requests.filter(({ id }) => !notifiedUiRequests.has(id));
        if (unseen.length) {
          await input.onUiRequired(path);
          for (const { id } of unseen) notifiedUiRequests.add(id);
        }
      }
      if (row.deadlineAt <= new Date())
        throw new UnsupportedOperationError(
          `Task deadline reached. Inspect the durable task at ${path}`,
        );
      await delay(500, undefined, { signal: input.signal });
    }
  } catch (error) {
    const recorded = await db.a2ATask.findUnique({
      where: { id: accepted.row.id },
      select: { snapshot: true, uiProjection: true },
    });
    if (recorded) {
      await observeActivities(recorded.uiProjection);
      await observePrompts(Task.fromJSON(recorded.snapshot));
    }
    // Work's explicit cancel flag is authoritative. A socket close/shutdown is not.
    if (input.kind === "work") {
      const work = await db.workSession.findFirst({
        where: {
          id: input.sourceId,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          a2aActorId: input.actorId,
        },
        select: { cancelRequestedAt: true },
      });
      if (work?.cancelRequestedAt) {
        await requestWorkEntryCancellation(input.sourceId, accepted.row.id);
        // Do not mark Work idle while its leased sandbox operation is still stopping.
        for (;;) {
          const current = await db.a2ATask.findUnique({
            where: { id: accepted.row.id },
          });
          if (!current || terminal(current.state)) break;
          await delay(500);
        }
      }
    }
    throw error;
  }
}
export function agentEntryResult(task: Task, path: string) {
  const text = task.artifacts
    .flatMap((a) =>
      a.parts.flatMap((p) =>
        p.content?.$case === "text" ? [p.content.value] : [],
      ),
    )
    .join("\n\n");
  const detail = task.status?.message?.parts
    .flatMap((p) => (p.content?.$case === "text" ? [p.content.value] : []))
    .join("\n");
  if (task.status?.state === TaskState.TASK_STATE_COMPLETED)
    return text || `Task completed. Results: ${path}`;
  if (task.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED)
    return detail || `More input is required: ${path}`;
  // Never let an error/cancelled task look like a successful legacy response.
  throw new UnsupportedOperationError(
    `Agent execution did not complete (${task.status?.state ?? "unknown"}). Inspect ${path}`,
  );
}

/** The admission validator reserves this metadata for trusted native callbacks. */
export function agentEntryPromptInvocations(
  task: Task,
  messageId?: string,
): AgentPromptInvocation[] {
  const user = task.history.findLast(
    (message) =>
      message.role === Role.ROLE_USER &&
      (!messageId || message.messageId === messageId),
  );
  const invocation = user?.metadata?.toolplanePromptInvocation;
  return invocation && typeof invocation === "object"
    ? [invocation as AgentPromptInvocation]
    : [];
}

export type AgentEntryRuntimePart =
  | {
      type: typeof RUNTIME_COMMANDS_PART;
      data: { runtimeKind: "pi-sdk" | "omp"; commands: RuntimeCommand[] };
    }
  | { type: typeof RUNTIME_USAGE_PART; data: RuntimeUsage }
  | { type: typeof AGENT_TURN_MODEL_PART; data: AgentModelOverride }
  | { type: typeof COMMAND_RESULT_PART; data: RuntimeCommandResult };
const piSdkMetadataSchema = z
  .object({
    commands: RuntimeCommandsSchema,
    model: z
      .object({ providerId: z.string().min(1), model: z.string().min(1) })
      .optional(),
    usage: z
      .object({
        inputTokens: z.number().finite().nonnegative(),
        outputTokens: z.number().finite().nonnegative(),
        cacheReadTokens: z.number().finite().nonnegative(),
        cacheWriteTokens: z.number().finite().nonnegative(),
        costUsd: z.number().finite().nonnegative().optional(),
      })
      .strict()
      .optional(),
    commandResult: z
      .object({
        command: z.string().min(1).max(A2A_LIMITS.inputCharacters),
        text: z.string().max(A2A_LIMITS.outputCharacters),
        status: z.enum(["completed", "failed"]),
      })
      .strict()
      .optional(),
  })
  .strict();
/** Project only the public runtime metadata, never SDK state or private paths. */
export function agentEntryRuntimeParts(task: Task): AgentEntryRuntimePart[] {
  if (task.status?.state !== TaskState.TASK_STATE_COMPLETED) return [];
  for (let index = task.artifacts.length - 1; index >= 0; index--) {
    const artifact = task.artifacts[index];
    if (!artifact.parts.some((part) => part.content?.$case === "text"))
      continue;
    const runtimeKind = artifact.metadata?.toolplaneOmp ? "omp" : "pi-sdk";
    const parsed = piSdkMetadataSchema.safeParse(
      runtimeKind === "omp"
        ? artifact.metadata?.toolplaneOmp
        : artifact.metadata?.toolplanePiSdk,
    );
    if (!parsed.success) continue;
    const { commands, usage, commandResult, model } = parsed.data;
    const parts: AgentEntryRuntimePart[] = [
      {
        type: RUNTIME_COMMANDS_PART,
        data: { runtimeKind, commands },
      },
    ];
    if (usage) parts.push({ type: RUNTIME_USAGE_PART, data: usage });
    if (model) parts.push({ type: AGENT_TURN_MODEL_PART, data: model });
    if (commandResult)
      parts.push({ type: COMMAND_RESULT_PART, data: commandResult });
    return parts;
  }
  return [];
}
