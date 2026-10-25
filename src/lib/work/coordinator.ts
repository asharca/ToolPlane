import { resolvePiSessionPackages } from "@/lib/agents/pi-session-packages";
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
import { normalizeReasoningEffort } from "@/lib/agents/constants";
import { generateWorkSessionTitle } from "@/lib/agents/conversation-naming";
import { activeConversationMessages } from "@/lib/agents/conversation-context";
import { getAgentForRun } from "@/lib/agents/queries";
import { resolvePinnedAgent } from "@/lib/agents/revisions";
import { persistAgentPromptInvocation } from "@/lib/agents/prompt-invocation";
import {
  resolveAgentTools,
  resolveAgentPiPackages,
} from "@/lib/agents/resolve";
import type { SandboxRuntimeActivity } from "@/lib/agents/sandbox-runtime";
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
import { runDedicatedSandboxTurn } from "@/lib/agents/sandbox-turn";
import { stopHermesWorkRun } from "@/lib/agents/hermes/work";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import { deploymentLabel } from "@/lib/workspace/deployment-label";
import {
  assertWorkPiPackageSnapshot,
  normalizeWorkDirectory,
} from "./sessions";
import {
  finishWorkOutput,
  publishWorkActivity,
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
  systemPrompt?: string | null;
  agentMaxSteps?: number;
  deploymentIds?: string[];
  installedSkillIds?: string[];
  knowledgeBaseIds?: string[];
  workingDirectory?: string;
  runtimeId?: string | null;
  hermesRunId?: string | null;
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
};

type WorkTracePart =
  | WorkToolPart
  | {
      type: "reasoning";
      text: string;
      state: "done";
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

function workSystemPrompt(workingDirectory: string): string {
  const displayPath =
    workingDirectory === "." ? "/workspace" : `/workspace/${workingDirectory}`;
  return [
    "You are working in a durable multi-turn session inside an authorized sandbox.",
    `Your current working directory is ${displayPath}. Sandbox command and file tool paths are resolved relative to it.`,
    "Use the available tools to perform and verify the work. Do not merely describe commands the user should run.",
    "When the current request is satisfied and verified, return a concise result. Ask one concrete question only when user input is required.",
    "Returning a final response completes only the current turn. The Work session remains available for later messages.",
  ].join("\n\n");
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
  const initialModelName = initialSnapshot.model ?? undefined;
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
  let reasoningSequence = 0;
  let reasoningActive = false;
  let runtimeStatus: "completed" | "failed" | "cancelled" = "completed";
  let tracePersisted = false;
  let contextUsage: ContextUsageSnapshot | undefined;
  let commands: RuntimeCommand[] | undefined;
  let usage: RuntimeUsage | undefined;
  let executedCommand: ParsedRuntimeCommand | null = null;
  let commandResult: RuntimeCommandResult | undefined;
  const runtimeMetadata = (): Prisma.InputJsonValue[] => [
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
    if (text) trace.push({ type: "reasoning", text, state: "done" });
    activeReasoningText = "";
    activeReasoningId = null;
    publishWorkActivity(work.id, {
      id,
      type: "reasoning",
      status: "completed",
      ...(text ? { text } : {}),
    });
  };
  const onActivity = (activity: SandboxRuntimeActivity) => {
    if (activity.type === "reasoning") {
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
        });
      } else if (reasoningActive || activeReasoningText) {
        reasoningActive = true;
        finishReasoning();
      } else {
        const text = activity.delta?.slice(0, MAX_REASONING_CHARACTERS) ?? "";
        if (text) trace.push({ type: "reasoning", text, state: "done" });
        publishWorkActivity(work.id, {
          id: `reasoning:${++reasoningSequence}`,
          type: "reasoning",
          status: "completed",
          ...(text ? { text } : {}),
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
      !["pi-sdk"].includes(work.runtimeKind) ||
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
    const liveAgent = await getAgentForRun(work.agentId, work.workspaceId);
    if (!liveAgent) throw new Error("Work Agent no longer exists.");
    const agent = await resolvePinnedAgent(liveAgent, work.agentRevisionId, {
      workspaceId: work.workspaceId,
    });
    if (agent.runtimeKind !== work.runtimeKind) {
      throw new Error(
        "The Agent runtime changed after this Work session was created. Start a new Work session.",
      );
    }
    const saved = snapshot(work.runtimeSnapshot);
    const piSession =
      work.runtimeKind === "pi-sdk"
        ? await resolvePiSessionPackages({
            workspaceId: work.workspaceId,
            agentId: work.agentId,
            conversationId: work.conversationId,
          })
        : undefined;
    const piPackages = piSession?.packages ?? resolveAgentPiPackages(agent);
    assertWorkPiPackageSnapshot(
      work.runtimeKind,
      work.runtimeSnapshot,
      piPackages,
    );
    const provider = agent.provider;
    const model = agent.model;
    if (!provider || !model)
      throw new Error("Work Agent has no configured model.");
    const workingDirectory =
      normalizeWorkDirectory(saved.workingDirectory ?? ".") ?? ".";

    const resolved = resolveAgentTools(
      piSession ? { ...agent, piPackages: [] } : agent,
      work.sandboxId,
    );
    if (piSession) resolved.deploymentIds = piSession.deploymentIds;
    const deploymentIds = saved.deploymentIds
      ? new Set(saved.deploymentIds)
      : null;
    const skillIds = saved.installedSkillIds
      ? new Set(saved.installedSkillIds)
      : null;
    const knowledgeBaseIds = saved.knowledgeBaseIds
      ? new Set(saved.knowledgeBaseIds)
      : null;
    resolved.deploymentIds = resolved.deploymentIds.filter(
      (id) =>
        resolved.sandboxDeploymentIds.includes(id) ||
        Boolean(piSession?.packageDeploymentIds.includes(id)) ||
        !deploymentIds ||
        deploymentIds.has(id),
    );
    resolved.skills = resolved.skills.filter(
      (skill) => !skillIds || skillIds.has((skill as { id?: string }).id ?? ""),
    );
    // Delegation is exposed only through the pinned SDK collaboration protocol.
    resolved.subAgents = [];
    if (resolved.knowledgeBases && knowledgeBaseIds) {
      resolved.knowledgeBases = resolved.knowledgeBases.filter((link) =>
        knowledgeBaseIds.has(link.knowledgeBase.id),
      );
    }
    resolvedDeploymentIds = resolved.deploymentIds;
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
      const command = parseRuntimeCommand(commandText, work.runtimeKind);
      executedCommand = command;
      const system = [agent.systemPrompt, workSystemPrompt(workingDirectory)]
        .filter(Boolean)
        .join("\n\n---\n\n");
      response = await runDedicatedSandboxTurn({
        agent,
        conversationId: work.conversationId,
        systemPrompt: system,
        messages: command ? runtimeMessages.slice(0, -1) : runtimeMessages,
        ...(command ? { command: commandText } : {}),
        runtimeSessionId: work.conversationId,
        skills: resolved.skills,
        piPackages,
        deploymentIds: resolved.deploymentIds.filter(
          (id) => !resolved.sandboxDeploymentIds.includes(id),
        ),
        workingDirectory,
        reasoningEffort:
          normalizeReasoningEffort(work.conversation.reasoningEffort) ??
          undefined,
        signal: controller.signal,
        onPromptInvocation: async (invocation) => {
          const message = runtimeMessages.findLast(
            (entry) => entry.role === "user",
          );
          if (!message?.id)
            throw new Error("Prompt invocation user message is unavailable.");
          await persistAgentPromptInvocation({
            conversationId: work.conversationId,
            messageId: message.id,
            invocation,
          });
        },
        onTextDelta: (delta) => {
          finishReasoning();
          publishWorkOutput(work.id, delta);
        },
        onActivity,
        onContextUsage: (usage) => {
          contextUsage = usage;
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
      runtimeMetadata(),
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
          runtimeMetadata(),
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
          status: { in: ["running", "waiting_approval"] },
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
        runtimeKind: "pi-sdk",
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

async function stopInterruptedHermesRuns() {
  const interrupted = await db.workSession.findMany({
    where: {
      runtimeKind: "hermes",
      status: { in: ["running", "waiting_approval", "cancelling"] },
    },
    select: {
      runtimeSnapshot: true,
      agent: {
        select: {
          id: true,
          workspaceId: true,
          runtime: { select: { id: true, kind: true } },
        },
      },
    },
  });
  await Promise.all(
    interrupted.map(async (work) => {
      const runId = snapshot(work.runtimeSnapshot).hermesRunId?.trim();
      if (runId) await stopHermesWorkRun({ agent: work.agent, runId });
    }),
  );
}

export async function startWorkCoordinator() {
  if (!state.reconciled) {
    const now = new Date();
    await stopInterruptedHermesRuns();
    await db.$transaction(async (tx) => {
      await tx.workApproval.updateMany({
        where: {
          status: "pending",
          workSession: { status: "waiting_approval" },
        },
        data: { status: "expired", resolvedAt: now },
      });
      await tx.workSession.updateMany({
        where: { status: { in: ["running", "waiting_approval"] } },
        data: {
          status: "failed",
          error:
            "Work was interrupted by a server restart. Review the transcript, then resume it.",
          completedAt: now,
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
