import { systemLog } from "@/lib/observability/system";
import "server-only";
import {
  runtimeCanOperate,
  trackRuntimeOperation,
} from "@/lib/runtime/ownership-state";
import { withLogContext, enrichLogContext } from "@/lib/observability/context";
import { recordEvent } from "@/lib/observability/events";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { generateWorkSessionTitle } from "@/lib/agents/conversation-naming";
import { activeConversationMessages } from "@/lib/agents/conversation-context";
import { persistAgentPromptInvocation } from "@/lib/agents/prompt-invocation";
import type { SandboxRuntimeActivity } from "@/lib/agents/sandbox-runtime";
import { nativeUiProjection } from "@/lib/agents/execution/native-ui";
import {
  COMMAND_RESULT_PART,
  RUNTIME_COMMANDS_PART,
  RUNTIME_USAGE_PART,
  parseRuntimeCommand,
} from "@/lib/agents/runtime-commands";
import type {
  ParsedRuntimeCommand,
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeUsage,
} from "@/lib/agents/runtime-commands";
import {
  runAgentEntry,
  agentEntryResult,
  agentEntryRuntimeParts,
} from "@/lib/agents/execution/entries";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import {
  agentMessageModelOverride,
  AGENT_TURN_MODEL_PART,
} from "@/lib/agents/turn-model";
import { deploymentLabel } from "@/lib/workspace/deployment-label";
import {
  finishWorkOutput,
  observeWorkRuntime,
  publishWorkActivity,
  publishWorkExecutionStage,
  publishWorkOutput,
  registerWorkRun,
  startWorkOutput,
  unregisterWorkRun,
} from "./run-control";

const MAX_CONCURRENT_WORK = 2;
const MAX_REASONING_CHARACTERS = 40_000;

type RuntimeSnapshot = {
  providerId?: string | null;
  model?: string | null;
  deploymentIds?: string[];
};

type RuntimeMessage = {
  id: string;
  role: string;
  parts: Array<{
    type: string;
    text?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    isError?: boolean;
    providerMetadata?: unknown;
    filename?: unknown;
  }>;
};

type WorkToolPart = {
  type: "work-tool";
  toolCallId: string;
  toolName: string;
  deploymentName?: string;
  originalToolName?: string;
  durationMs?: number;
  input: unknown;
  output?: unknown;
  isError: boolean;
  status: "running" | "completed" | "failed" | "cancelled";
  source?: SandboxRuntimeActivity["source"];
};

type WorkTracePart =
  | WorkToolPart
  | {
      type: "reasoning";
      text: string;
      state: "done";
      source?: SandboxRuntimeActivity["source"];
    }
  | {
      type: "work-runtime";
      runtimeKind: string;
      status: "completed" | "failed" | "cancelled";
    };

type WorkProcessPart = Exclude<WorkTracePart, { type: "work-runtime" }>;

type WorkTurnTiming = {
  startedAt: number;
  completedAt: number;
  durationMs: number;
  approvalWaitMs?: number;
  runtimeKind: string;
  modelName?: string;
};

type CoordinatorState = {
  draining: boolean;
  stopping?: boolean;
  active: Set<string>;
  titleGenerations?: Set<string>;
  timer?: ReturnType<typeof setInterval>;
  reconciled: boolean;
};

const coordinatorGlobal = globalThis as unknown as {
  __workCoordinator?: CoordinatorState;
};
const state = coordinatorGlobal.__workCoordinator ?? {
  draining: false,
  active: new Set<string>(),
  reconciled: false,
};
coordinatorGlobal.__workCoordinator = state;
state.titleGenerations ??= new Set<string>();
const pendingTitles = state.titleGenerations;

export function isWorkSessionTitlePending(workSessionId: string) {
  return pendingTitles.has(workSessionId);
}

function snapshot(value: Prisma.JsonValue | null): RuntimeSnapshot {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RuntimeSnapshot)
    : {};
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Work cancelled");
}

async function appendAssistantResult(
  conversationId: string,
  text: string,
  trace: WorkTracePart[],
  contextUsage?: ContextUsageSnapshot,
  timing?: WorkTurnTiming,
  metadata: Prisma.InputJsonValue[] = [],
) {
  const parts: Prisma.InputJsonValue[] = [
    ...metadata,
    ...(trace as unknown as Prisma.InputJsonValue[]),
    ...(text
      ? [{ type: "text", text, state: "done" } as Prisma.InputJsonValue]
      : []),
    ...(contextUsage
      ? [
          {
            type: "data-context-usage",
            data: contextUsage,
          } as Prisma.InputJsonValue,
        ]
      : []),
    ...(timing
      ? [{ type: "data-work-timing", data: timing } as Prisma.InputJsonValue]
      : []),
  ];
  if (!parts.length) return;
  await db.message.create({
    data: {
      conversationId,
      role: "assistant",
      parts,
      textCharacters: text.length,
    },
  });
}

async function executeWork(workSessionId: string) {
  const work = await db.workSession.findUnique({
    where: { id: workSessionId },
    include: {
      sandbox: { include: { deployment: true } },
      conversation: {
        include: {
          messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
        },
      },
    },
  });
  if (!work) {
    finishWorkOutput(workSessionId);
    return;
  }
  enrichLogContext({
    workspaceId: work.workspaceId,
    agentId: work.agentId,
    runId: work.id,
    conversationId: work.conversationId,
  });
  if (work.status === "cancelling") {
    await db.workSession.updateMany({
      where: {
        id: work.id,
        workspaceId: work.workspaceId,
        status: "cancelling",
      },
      data: {
        status: "idle",
        error: null,
        waitingQuestion: null,
        completedAt: new Date(),
      },
    });
    finishWorkOutput(work.id);
    return;
  }
  if (work.status !== "running") {
    finishWorkOutput(work.id);
    return;
  }
  const controller = new AbortController();
  registerWorkRun(work.id, controller);
  const runStartedAt = Date.now();
  const initialSnapshot = snapshot(work.runtimeSnapshot);
  const turnOverride = agentMessageModelOverride(
    work.conversation.messages.findLast((message) => message.role === "user")
      ?.parts,
  );
  const initialModelName =
    turnOverride?.model ?? initialSnapshot.model ?? undefined;
  startWorkOutput(work.id, {
    startedAt: runStartedAt,
    runtimeKind: work.runtimeKind,
    ...(initialModelName ? { modelName: initialModelName } : {}),
  });
  publishWorkActivity(work.id, {
    id: "runtime",
    type: "runtime",
    status: "running",
    runtimeKind: work.runtimeKind,
  });
  const toolTrace = new Map<string, WorkToolPart>();
  const toolStartedAt = new Map<string, number>();
  const trace: WorkProcessPart[] = [];
  let reasoningText = "";
  let activeReasoningText = "";
  let activeReasoningId: string | null = null;
  let activeReasoningSource: SandboxRuntimeActivity["source"];
  let reasoningSequence = 0;
  let reasoningActive = false;
  let runtimeStatus: "completed" | "failed" | "cancelled" = "completed";
  let tracePersisted = false;
  let contextUsage: ContextUsageSnapshot | undefined;
  let commands: RuntimeCommand[] | undefined;
  let usage: RuntimeUsage | undefined;
  let executedCommand: ParsedRuntimeCommand | null = null;
  let commandResult: RuntimeCommandResult | undefined;
  const previousHookIds =
    work.runtimeKind === "omp"
      ? new Set(
          nativeUiProjection(work.uiProjection).hooks.map((hook) => hook.id),
        )
      : null;
  const hookMetadata = async (): Promise<Prisma.InputJsonValue[]> => {
    if (!previousHookIds) return [];
    const current = await db.workSession.findFirst({
      where: {
        id: work.id,
        workspaceId: work.workspaceId,
        agentId: work.agentId,
        conversationId: work.conversationId,
      },
      select: { uiProjection: true },
    });
    return nativeUiProjection(current?.uiProjection)
      .hooks.filter((hook) => !previousHookIds.has(hook.id))
      .map((hook) => ({ type: "hook-activity", data: hook }));
  };
  const runtimeMetadata = (): Prisma.InputJsonValue[] => [
    ...(initialModelName &&
    (turnOverride?.providerId ?? initialSnapshot.providerId)
      ? [
          {
            type: AGENT_TURN_MODEL_PART,
            data: {
              providerId:
                turnOverride?.providerId ?? initialSnapshot.providerId,
              model: initialModelName,
            },
          } as Prisma.InputJsonValue,
        ]
      : []),
    ...(commands
      ? [
          {
            type: RUNTIME_COMMANDS_PART,
            data: { runtimeKind: work.runtimeKind, commands },
          } as Prisma.InputJsonValue,
        ]
      : []),
    ...(usage
      ? [{ type: RUNTIME_USAGE_PART, data: usage } as Prisma.InputJsonValue]
      : []),
    ...(commandResult
      ? [
          {
            type: COMMAND_RESULT_PART,
            data: commandResult,
          } as Prisma.InputJsonValue,
        ]
      : []),
  ];
  let deploymentNames = new Map<string, string>();
  let resolvedDeploymentIds: string[] = [];

  const turnTiming = (completedAt = Date.now()): WorkTurnTiming => {
    const modelName = contextUsage?.modelName ?? initialModelName;
    return {
      startedAt: runStartedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - runStartedAt),
      runtimeKind: work.runtimeKind,
      ...(modelName ? { modelName } : {}),
    };
  };

  const finishReasoning = () => {
    if (!reasoningActive) return;
    reasoningActive = false;
    const text = activeReasoningText;
    const id = activeReasoningId ?? `reasoning:${++reasoningSequence}`;
    if (text)
      trace.push({
        type: "reasoning",
        text,
        state: "done",
        ...(activeReasoningSource ? { source: activeReasoningSource } : {}),
      });
    activeReasoningText = "";
    activeReasoningId = null;
    publishWorkActivity(work.id, {
      id,
      type: "reasoning",
      status: "completed",
      ...(text ? { text } : {}),
      ...(activeReasoningSource ? { source: activeReasoningSource } : {}),
    });
    activeReasoningSource = undefined;
  };
  const onActivity = (activity: SandboxRuntimeActivity) => {
    if (activity.type === "reasoning") {
      if (activeReasoningSource?.subagentId !== activity.source?.subagentId)
        finishReasoning();
      activeReasoningSource = activity.source;
      if (!reasoningActive && activity.status === "running") {
        reasoningActive = true;
        activeReasoningId = `reasoning:${++reasoningSequence}`;
      }
      if (activity.delta && reasoningText.length < MAX_REASONING_CHARACTERS) {
        const delta = activity.delta.slice(
          0,
          MAX_REASONING_CHARACTERS - reasoningText.length,
        );
        reasoningText += delta;
        activeReasoningText += delta;
      }
      if (activity.status === "running") {
        publishWorkActivity(work.id, {
          id: activeReasoningId ?? `reasoning:${++reasoningSequence}`,
          type: "reasoning",
          status: "running",
          ...(activeReasoningText ? { text: activeReasoningText } : {}),
          ...(activity.source ? { source: activity.source } : {}),
        });
      } else if (reasoningActive || activeReasoningText) {
        reasoningActive = true;
        finishReasoning();
      } else {
        const text = activity.delta?.slice(0, MAX_REASONING_CHARACTERS) ?? "";
        if (text)
          trace.push({
            type: "reasoning",
            text,
            state: "done",
            ...(activity.source ? { source: activity.source } : {}),
          });
        publishWorkActivity(work.id, {
          id: `reasoning:${++reasoningSequence}`,
          type: "reasoning",
          status: "completed",
          ...(text ? { text } : {}),
          ...(activity.source ? { source: activity.source } : {}),
        });
      }
      return;
    }
    finishReasoning();
    if (!activity.toolCallId) return;
    const previous = toolTrace.get(activity.toolCallId);
    const candidateDeploymentId = activity.deploymentId;
    const deploymentId =
      candidateDeploymentId &&
      resolvedDeploymentIds.includes(candidateDeploymentId)
        ? candidateDeploymentId
        : undefined;
    const deploymentName = deploymentId
      ? (deploymentNames.get(deploymentId) ?? previous?.deploymentName)
      : previous?.deploymentName;
    const originalToolName = deploymentId
      ? (activity.originalToolName ?? previous?.originalToolName)
      : previous?.originalToolName;
    const startedAt = toolStartedAt.get(activity.toolCallId);
    const reportedDurationMs =
      typeof activity.durationMs === "number" &&
      Number.isFinite(activity.durationMs) &&
      activity.durationMs >= 0
        ? Math.round(activity.durationMs)
        : undefined;
    if (activity.status === "running" && startedAt === undefined) {
      toolStartedAt.set(activity.toolCallId, Date.now());
    }
    const durationMs =
      activity.status === "running"
        ? previous?.durationMs
        : (previous?.durationMs ??
          reportedDurationMs ??
          (startedAt === undefined
            ? undefined
            : Math.max(0, Date.now() - startedAt)));
    const part: WorkToolPart = {
      type: "work-tool",
      toolCallId: activity.toolCallId,
      toolName: activity.toolName ?? previous?.toolName ?? "Tool",
      ...(deploymentName ? { deploymentName } : {}),
      ...(originalToolName ? { originalToolName } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
      input:
        activity.input === undefined
          ? (previous?.input ?? null)
          : activity.input,
      ...(activity.output === undefined ? {} : { output: activity.output }),
      isError: activity.status === "failed" || activity.isError === true,
      status: activity.status,
      ...((activity.source ?? previous?.source)
        ? { source: activity.source ?? previous?.source }
        : {}),
    };
    const next = previous ? Object.assign(previous, part) : part;
    if (!previous) {
      toolTrace.set(activity.toolCallId, next);
      trace.push(next);
    }
    publishWorkActivity(work.id, {
      id: `tool:${activity.toolCallId}`,
      type: "tool",
      status: activity.status,
      toolCallId: activity.toolCallId,
      toolName: next.toolName,
      ...(next.source ? { source: next.source } : {}),
      ...(next.deploymentName ? { deploymentName: next.deploymentName } : {}),
      ...(next.originalToolName
        ? { originalToolName: next.originalToolName }
        : {}),
      ...(next.durationMs === undefined ? {} : { durationMs: next.durationMs }),
      input: next.input,
      ...(next.output === undefined ? {} : { output: next.output }),
      isError: next.isError,
    });
  };
  const settleUnfinishedTools = (status: "failed" | "cancelled") => {
    for (const [toolCallId, part] of toolTrace) {
      if (part.status !== "running") continue;
      const startedAt = toolStartedAt.get(toolCallId);
      const durationMs =
        part.durationMs ??
        (startedAt === undefined
          ? undefined
          : Math.max(0, Date.now() - startedAt));
      const settled = Object.assign(part, {
        status,
        isError: status === "failed",
        ...(durationMs === undefined ? {} : { durationMs }),
      } as const);
      publishWorkActivity(work.id, {
        id: `tool:${toolCallId}`,
        type: "tool",
        status,
        toolCallId,
        toolName: settled.toolName,
        ...(settled.source ? { source: settled.source } : {}),
        ...(settled.deploymentName
          ? { deploymentName: settled.deploymentName }
          : {}),
        ...(settled.originalToolName
          ? { originalToolName: settled.originalToolName }
          : {}),
        ...(settled.durationMs === undefined
          ? {}
          : { durationMs: settled.durationMs }),
        input: settled.input,
        isError: settled.isError,
      });
    }
  };
  const traceParts = (): WorkTracePart[] => {
    const parts: WorkTracePart[] = [...trace];
    return runtimeStatus === "completed" && parts.length
      ? parts
      : [
          ...parts,
          {
            type: "work-runtime",
            runtimeKind: work.runtimeKind,
            status: runtimeStatus,
          },
        ];
  };
  try {
    const stillRunning = await db.workSession.count({
      where: { id: work.id, status: "running" },
    });
    if (!stillRunning) return;
    if (
      work.runtimeKind !== "pi-sdk" ||
      work.legacyRevisionUnresolved ||
      !work.agentRevisionId ||
      work.conversation.legacyRevisionUnresolved ||
      work.conversation.agentRevisionId !== work.agentRevisionId
    ) {
      throw new Error(
        "Historical Work is read-only. Start a new Work session.",
      );
    }
    if (!work.sandbox) {
      throw new Error("Work sandbox is unavailable.");
    }
    if (!work.a2aActorId)
      throw new Error("Work execution identity is unavailable.");
    // Labels are display metadata, not authority. The admitted worker resolves and
    // intersects the pinned Work resources with current permissions before execution.
    resolvedDeploymentIds = snapshot(work.runtimeSnapshot).deploymentIds ?? [];
    if (resolvedDeploymentIds.length) {
      const deployments = await db.deployment.findMany({
        where: {
          workspaceId: work.workspaceId,
          id: { in: resolvedDeploymentIds },
        },
        select: {
          id: true,
          serverId: true,
          name: true,
          source: true,
          sourceRef: true,
          server: { select: { name: true } },
        },
      });
      deploymentNames = new Map(
        deployments.map((deployment) => [
          deployment.id,
          deploymentLabel(deployment).name,
        ]),
      );
    }

    const runtimeMessages: RuntimeMessage[] = activeConversationMessages(
      work.conversation.messages,
    ).map((message) => ({
      id: message.id,
      role: message.role,
      parts: message.parts as RuntimeMessage["parts"],
    }));
    let response: string;
    {
      const last = runtimeMessages.at(-1);
      const commandText =
        last?.role === "user"
          ? last.parts
              .filter((part) => part.type === "text" && !("reference" in part))
              .map((part) => part.text ?? "")
              .join("\n")
          : "";
      executedCommand = parseRuntimeCommand(commandText, work.runtimeKind);
      if (!last?.id || last.role !== "user")
        throw new Error("Work user message is unavailable.");
      const stopObserving = observeWorkRuntime(work.id, {
        onTextDelta: (delta) => {
          finishReasoning();
          publishWorkOutput(work.id, delta);
        },
        onActivity,
        onExecutionStage: (stage) => publishWorkExecutionStage(work.id, stage),
        onContextUsage: (next) => {
          contextUsage = next;
        },
        onCommands: (next) => {
          commands = next;
        },
        onUsage: (next) => {
          usage = next;
        },
        onCommandResult: (next) => {
          commandResult = next;
        },
      });
      try {
        const result = await runAgentEntry({
          kind: "work",
          sourceId: work.id,
          workspaceId: work.workspaceId,
          agentId: work.agentId,
          actorId: work.a2aActorId,
          messageId: last.id,
          text: commandText,
          modelOverride: turnOverride,
          signal: controller.signal,
          onActivity: (activity) => {
            // Native activities already stream from the leased executor above.
            if (activity.toolCallId?.startsWith("platform-child:"))
              onActivity(activity);
          },
          onPromptInvocation: (invocation) =>
            persistAgentPromptInvocation({
              conversationId: work.conversationId,
              messageId: last.id,
              invocation,
            }),
        });
        response = agentEntryResult(result.task, result.path);
        // Durable metadata also covers a task that completed before this observer attached.
        for (const part of agentEntryRuntimeParts(result.task)) {
          if (part.type === RUNTIME_COMMANDS_PART)
            commands = part.data.commands;
          else if (part.type === RUNTIME_USAGE_PART) usage = part.data;
          else if (part.type === COMMAND_RESULT_PART) commandResult = part.data;
        }
      } finally {
        stopObserving();
      }
    }
    if (controller.signal.aborted) throw abortError(controller.signal);
    const fallbackText = response.trim();
    finishReasoning();
    settleUnfinishedTools("failed");
    publishWorkActivity(work.id, {
      id: "runtime:final",
      type: "runtime",
      status: "completed",
      runtimeKind: work.runtimeKind,
    });

    await appendAssistantResult(
      work.conversationId,
      fallbackText,
      traceParts(),
      contextUsage,
      turnTiming(),
      [...runtimeMetadata(), ...(await hookMetadata())],
    );
    tracePersisted = true;
    if (!executedCommand && !pendingTitles.has(work.id)) {
      pendingTitles.add(work.id);
      void generateWorkSessionTitle(
        work.workspaceId,
        work.agentId,
        work.conversationId,
      )
        .catch((error) =>
          systemLog("warn", `[work] ${work.id} title generation failed`, error),
        )
        .finally(() => pendingTitles.delete(work.id));
    }
    await db.workSession.updateMany({
      where: { id: work.id, status: "running" },
      data: {
        status: "idle",
        result: null,
        error: null,
        waitingQuestion: null,
        completedAt: new Date(),
      },
    });
  } catch (error) {
    runtimeStatus = controller.signal.aborted ? "cancelled" : "failed";
    await recordEvent({
      domain: "agent",
      eventName: "work.run.failed",
      runId: work.id,
      outcome: controller.signal.aborted ? "cancelled" : "error",
      error,
      durationMs: Date.now() - runStartedAt,
    });
    finishReasoning();
    settleUnfinishedTools(runtimeStatus);
    publishWorkActivity(work.id, {
      id: "runtime:final",
      type: "runtime",
      status: runtimeStatus,
      runtimeKind: work.runtimeKind,
    });
    if (!tracePersisted) {
      try {
        await appendAssistantResult(
          work.conversationId,
          "",
          traceParts(),
          contextUsage,
          turnTiming(),
          [...runtimeMetadata(), ...(await hookMetadata())],
        );
        tracePersisted = true;
      } catch (traceError) {
        systemLog(
          "error",
          `[work] ${work.id} activity persistence failed`,
          traceError,
        );
      }
    }
    if (!controller.signal.aborted) {
      await db.workSession.updateMany({
        where: {
          id: workSessionId,
          status: { in: ["running"] },
        },
        data: {
          status: "failed",
          error: (error instanceof Error ? error.message : String(error)).slice(
            0,
            500,
          ),
          completedAt: new Date(),
        },
      });
    }
  } finally {
    unregisterWorkRun(workSessionId, controller);
    try {
      await db.workSession.updateMany({
        where: { id: workSessionId, status: "cancelling" },
        data: {
          status: "idle",
          error: null,
          waitingQuestion: null,
          completedAt: new Date(),
        },
      });
    } finally {
      finishWorkOutput(workSessionId);
    }
  }
}

async function runClaimedWork(workSessionId: string) {
  try {
    await trackRuntimeOperation(() =>
      withLogContext(
        { runId: workSessionId },
        () => executeWork(workSessionId),
        true,
      ),
    );
  } catch (error) {
    systemLog("error", `[work] ${workSessionId} execution failed`, error);
  } finally {
    state.active.delete(workSessionId);
    kickWorkCoordinator();
  }
}

async function claimNextWork(): Promise<string | null> {
  while (true) {
    const work = await db.workSession.findFirst({
      where: {
        status: "queued",
        runtimeKind: { in: ["pi-sdk"] },
        agentRevisionId: { not: null },
        legacyRevisionUnresolved: false,
        conversation: {
          agentRevisionId: { not: null },
          legacyRevisionUnresolved: false,
        },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, startedAt: true },
    });
    if (!work) return null;
    const claimed = await db.workSession.updateMany({
      where: { id: work.id, status: "queued" },
      data: {
        status: "running",
        error: null,
        waitingQuestion: null,
        ...(!work.startedAt ? { startedAt: new Date() } : {}),
      },
    });
    if (claimed.count) return work.id;
  }
}

async function drainWorkQueue() {
  if (state.draining || state.stopping || !runtimeCanOperate()) return;
  state.draining = true;
  try {
    while (
      !state.stopping &&
      runtimeCanOperate() &&
      state.active.size < MAX_CONCURRENT_WORK
    ) {
      const workSessionId = await claimNextWork();
      if (!workSessionId) break;
      state.active.add(workSessionId);
      void runClaimedWork(workSessionId).catch((error) =>
        systemLog(
          "error",
          `[work] ${workSessionId} finalization failed`,
          error,
        ),
      );
    }
  } finally {
    state.draining = false;
  }
}

export function kickWorkCoordinator() {
  void drainWorkQueue().catch((error) =>
    systemLog("error", "[work] queue drain failed", error),
  );
}

export async function startWorkCoordinator() {
  if (!state.reconciled) {
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.workSession.updateMany({
        where: { status: { in: ["running"] } },
        data: {
          status: "failed",
          error:
            "Work was interrupted by a server restart. Review the transcript, then resume it.",
          completedAt: now,
          uiLease: null,
        },
      });
      await tx.workSession.updateMany({
        where: { status: "cancelling" },
        data: {
          status: "idle",
          error: null,
          waitingQuestion: null,
          completedAt: now,
        },
      });
    });
    state.reconciled = true;
  }
  // ponytail: single-node poller; add Postgres leases only when a second runtime worker exists.
  if (!state.timer) {
    state.timer = setInterval(kickWorkCoordinator, 1_000);
    state.timer.unref?.();
  }
  kickWorkCoordinator();
}

export function stopWorkCoordinator() {
  state.stopping = true;
  if (state.timer) clearInterval(state.timer);
  for (const id of state.active) {
    void import("./run-control").then(({ abortWorkRun }) => abortWorkRun(id));
  }
}
