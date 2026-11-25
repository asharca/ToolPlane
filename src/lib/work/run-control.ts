import "server-only";
import type { Prisma } from "@prisma/client";
import type { StreamRuleTrigger } from "@/lib/agents/stream-rules";
import type {
  RunSandboxAgentTurnOptions,
  SandboxRuntimeActivity,
} from "@/lib/agents/sandbox-runtime";
import type { AgentExecutionStage } from "@/lib/agents/execution-stages";
import type { BudgetWarning } from "@/lib/agents/budget-warning";
import type { AgentMessageQueue } from "@/lib/agents/execution/message-queue";

type Registry = Map<string, AbortController>;

export type WorkRuntimeObserver = Pick<
  RunSandboxAgentTurnOptions,
  | "onTextDelta"
  | "onActivity"
  | "onExecutionStage"
  | "onContextUsage"
  | "onCommands"
  | "onUsage"
  | "onCommandResult"
  | "onStreamRule"
  | "onQueuedMessage"
  | "onMessageQueue"
  | "onContextMaintenance"
> & {
  queuedReplyParts?: (assistantText: string) => Prisma.InputJsonValue[];
};

export type WorkOutputSnapshot = {
  text: string;
  activities: WorkOutputActivity[];
  streamRuleTriggers?: StreamRuleTrigger[];
  active: boolean;
  done: boolean;
  executionStage?: AgentExecutionStage;
  startedAt?: number;
  completedAt?: number;
  /** Execution stage transitions, kept for the turn's timing waterfall. */
  stages?: Array<{ stage: AgentExecutionStage; at: number }>;
  runtimeKind?: string;
  modelName?: string;
  budgetWarning?: BudgetWarning;
  messageQueue?: AgentMessageQueue;
};

export type WorkOutputActivity = {
  id: string;
  type: "runtime" | "reasoning" | "tool";
  status: "running" | "completed" | "failed" | "cancelled";
  source?: SandboxRuntimeActivity["source"];
  runtimeKind?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  deploymentName?: string;
  originalToolName?: string;
  durationMs?: number;
  startedAt?: number;
  completedAt?: number;
  input?: unknown;
  output?: unknown;
  patch?: string;
  truncated?: boolean;
  firstChangedLine?: number;
  isError?: boolean;
  /** Length of the streamed reply text when this activity began. */
  textOffset?: number;
};

export type WorkOutputEvent =
  | { type: "start"; snapshot: WorkOutputSnapshot }
  | { type: "stage"; snapshot: WorkOutputSnapshot }
  | { type: "delta"; delta: string; snapshot: WorkOutputSnapshot }
  | {
      type: "data-budget-warning";
      data: BudgetWarning;
      snapshot: WorkOutputSnapshot;
    }
  | {
      type: "stream_rule_triggered";
      trigger: StreamRuleTrigger;
      snapshot: WorkOutputSnapshot;
    }
  | {
      type: "activity";
      activity: WorkOutputActivity;
      snapshot: WorkOutputSnapshot;
    }
  | { type: "done"; snapshot: WorkOutputSnapshot };

type WorkOutputListener = (event: WorkOutputEvent) => void;
type WorkOutputChannel = WorkOutputSnapshot & {
  listeners: Set<WorkOutputListener>;
  cleanup?: ReturnType<typeof setTimeout>;
};
type OutputRegistry = Map<string, WorkOutputChannel>;

const globalRegistry = globalThis as unknown as {
  __workRunControllers?: Registry;
  __workOutputChannels?: OutputRegistry;
  __workRuntimeObservers?: Map<string, WorkRuntimeObserver>;
};
const controllers =
  globalRegistry.__workRunControllers ?? new Map<string, AbortController>();
// ponytail: process-local replay matches the coordinator; use shared pub/sub when horizontally scaling.
const outputChannels =
  globalRegistry.__workOutputChannels ?? new Map<string, WorkOutputChannel>();
globalRegistry.__workRunControllers = controllers;
globalRegistry.__workOutputChannels = outputChannels;
const runtimeObservers =
  globalRegistry.__workRuntimeObservers ??
  new Map<string, WorkRuntimeObserver>();
globalRegistry.__workRuntimeObservers = runtimeObservers;

/** Presentation callbacks never grant execution authority; the worker owns the lease. */
export function observeWorkRuntime(
  workSessionId: string,
  observer: WorkRuntimeObserver,
) {
  runtimeObservers.set(workSessionId, observer);
  return () => {
    if (runtimeObservers.get(workSessionId) === observer)
      runtimeObservers.delete(workSessionId);
  };
}

export function workRuntimeObserver(workSessionId: string) {
  return runtimeObservers.get(workSessionId);
}

function outputChannel(workSessionId: string): WorkOutputChannel {
  let channel = outputChannels.get(workSessionId);
  if (!channel) {
    channel = {
      text: "",
      activities: [],
      active: false,
      done: false,
      listeners: new Set(),
    };
    outputChannels.set(workSessionId, channel);
  }
  return channel;
}

function outputSnapshot(channel: WorkOutputChannel): WorkOutputSnapshot {
  return {
    text: channel.text,
    activities: channel.activities.map((activity) => ({ ...activity })),
    ...(channel.streamRuleTriggers?.length
      ? {
          streamRuleTriggers: channel.streamRuleTriggers.map((trigger) => ({
            ...trigger,
          })),
        }
      : {}),
    active: channel.active,
    done: channel.done,
    ...(channel.executionStage
      ? { executionStage: channel.executionStage }
      : {}),
    ...(channel.startedAt === undefined
      ? {}
      : { startedAt: channel.startedAt }),
    ...(channel.runtimeKind === undefined
      ? {}
      : { runtimeKind: channel.runtimeKind }),
    ...(channel.modelName === undefined
      ? {}
      : { modelName: channel.modelName }),
    ...(channel.budgetWarning ? { budgetWarning: channel.budgetWarning } : {}),
    ...(channel.messageQueue ? { messageQueue: channel.messageQueue } : {}),
  };
}

function notifyOutput(channel: WorkOutputChannel, event: WorkOutputEvent) {
  for (const listener of channel.listeners) {
    try {
      listener(event);
    } catch {
      channel.listeners.delete(listener);
    }
  }
}

export function startWorkOutput(
  workSessionId: string,
  metadata: Pick<
    WorkOutputSnapshot,
    "startedAt" | "runtimeKind" | "modelName"
  > = {},
) {
  const channel = outputChannel(workSessionId);
  if (channel.cleanup) clearTimeout(channel.cleanup);
  channel.cleanup = undefined;
  channel.text = "";
  channel.activities = [];
  channel.budgetWarning = undefined;
  channel.streamRuleTriggers = [];
  channel.messageQueue = { messages: [], pendingMessageCount: 0 };
  channel.active = true;
  channel.done = false;
  channel.executionStage = "queued";
  channel.startedAt = metadata.startedAt ?? Date.now();
  channel.runtimeKind = metadata.runtimeKind;
  channel.modelName = metadata.modelName;
  notifyOutput(channel, { type: "start", snapshot: outputSnapshot(channel) });
}

export function publishWorkExecutionStage(
  workSessionId: string,
  stage: AgentExecutionStage,
) {
  const channel = outputChannel(workSessionId);
  if (!channel.active || channel.done || channel.executionStage === stage)
    return;
  channel.executionStage = stage;
  notifyOutput(channel, { type: "stage", snapshot: outputSnapshot(channel) });
}
export function publishWorkMessageQueue(
  workSessionId: string,
  queue: AgentMessageQueue,
) {
  const channel = outputChannel(workSessionId);
  channel.messageQueue = queue;
  notifyOutput(channel, { type: "stage", snapshot: outputSnapshot(channel) });
}

export function resetWorkMessageOutput(workSessionId: string) {
  const channel = outputChannel(workSessionId);
  channel.text = "";
  channel.activities = [];
  notifyOutput(channel, { type: "stage", snapshot: outputSnapshot(channel) });
}

export function publishWorkBudgetWarning(
  workSessionId: string,
  warning: BudgetWarning,
) {
  const channel = outputChannel(workSessionId);
  if (!channel.active || channel.done || channel.budgetWarning) return;
  channel.budgetWarning = warning;
  notifyOutput(channel, {
    type: "data-budget-warning",
    data: warning,
    snapshot: outputSnapshot(channel),
  });
}

export function publishWorkActivity(
  workSessionId: string,
  activity: WorkOutputActivity,
) {
  const channel = outputChannel(workSessionId);
  if (channel.cleanup) clearTimeout(channel.cleanup);
  channel.cleanup = undefined;
  const index = channel.activities.findIndex((item) => item.id === activity.id);
  const next =
    index < 0
      ? { ...activity, textOffset: channel.text.length }
      : { ...channel.activities[index], ...activity };
  if (index < 0) channel.activities.push(next);
  else channel.activities[index] = next;
  channel.active = true;
  channel.done = false;
  notifyOutput(channel, {
    type: "activity",
    activity: { ...next },
    snapshot: outputSnapshot(channel),
  });
}

export function publishWorkStreamRule(
  workSessionId: string,
  trigger: StreamRuleTrigger,
) {
  const channel = outputChannel(workSessionId);
  if (!channel.active || channel.done) return;
  channel.streamRuleTriggers ??= [];
  if (channel.streamRuleTriggers.some((item) => item.id === trigger.id)) return;
  channel.streamRuleTriggers.push(trigger);
  notifyOutput(channel, {
    type: "stream_rule_triggered",
    trigger,
    snapshot: outputSnapshot(channel),
  });
}

export function publishWorkOutput(workSessionId: string, delta: string) {
  if (!delta) return;
  const channel = outputChannel(workSessionId);
  if (channel.cleanup) clearTimeout(channel.cleanup);
  channel.cleanup = undefined;
  channel.text += delta;
  channel.active = true;
  channel.done = false;
  notifyOutput(channel, {
    type: "delta",
    delta,
    snapshot: outputSnapshot(channel),
  });
}

export function finishWorkOutput(workSessionId: string) {
  const channel = outputChannel(workSessionId);
  if (channel.done && !channel.active) return;
  channel.active = false;
  channel.done = true;
  channel.executionStage = undefined;
  channel.messageQueue = { messages: [], pendingMessageCount: 0 };
  notifyOutput(channel, { type: "done", snapshot: outputSnapshot(channel) });
  // Keep a short replay window for clients that reconnect as the DB update settles.
  if (channel.cleanup) clearTimeout(channel.cleanup);
  channel.cleanup = setTimeout(() => {
    if (outputChannels.get(workSessionId) === channel)
      outputChannels.delete(workSessionId);
  }, 60_000);
  channel.cleanup.unref?.();
}

export function subscribeWorkOutput(
  workSessionId: string,
  listener: WorkOutputListener,
): { snapshot: WorkOutputSnapshot; unsubscribe: () => void } {
  const channel = outputChannel(workSessionId);
  channel.listeners.add(listener);
  return {
    snapshot: outputSnapshot(channel),
    unsubscribe: () => channel.listeners.delete(listener),
  };
}

export function registerWorkRun(
  workSessionId: string,
  controller: AbortController,
) {
  controllers.set(workSessionId, controller);
}

export function unregisterWorkRun(
  workSessionId: string,
  controller: AbortController,
) {
  if (controllers.get(workSessionId) === controller)
    controllers.delete(workSessionId);
}

export function abortWorkRun(workSessionId: string) {
  const controller = controllers.get(workSessionId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function isWorkRunActive(workSessionId: string) {
  return controllers.has(workSessionId);
}
