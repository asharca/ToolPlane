import "server-only";
import type { SandboxRuntimeActivity } from "@/lib/agents/sandbox-runtime";
import type { AgentExecutionStage } from "@/lib/agents/execution-stages";
import type { LiveTaskActivity, LiveTaskOutput } from "./live-output-types";
import { redactText, sanitizeLog } from "@/lib/observability/redaction";
import type { AgentMessageQueue } from "./message-queue";

// Replay is process-local, like the leased worker. Durable terminal projections
// are stored once in the task ledger, never once per token.
const MAX_TASKS = 128;
const MAX_TEXT = 65_536;
const MAX_ACTIVITIES = 48;
const MAX_VALUE = 2048;
const REPLAY_MS = 60_000;
const ACTIVE_TTL_MS = 3_600_000;
type Capture = {
  output: LiveTaskOutput;
  secrets: readonly string[];
  reasoningId?: string;
  sequence: number;
  expires: number;
};
type Listener = (
  taskId: string,
  reason: "start" | "update" | "persist",
) => void;
type OutputState = {
  tasks: Map<string, Capture>;
  listeners: Set<Listener>;
  cleanup?: NodeJS.Timeout;
};
const globalOutput = globalThis as typeof globalThis & {
  __agentLiveOutput?: OutputState;
};
globalOutput.__agentLiveOutput ??= {
  tasks: new Map<string, Capture>(),
  listeners: new Set<Listener>(),
};
const state = globalOutput.__agentLiveOutput;
function prune() {
  for (const [id, capture] of state.tasks)
    if (capture.expires <= Date.now()) state.tasks.delete(id);
  while (state.tasks.size > MAX_TASKS) {
    const oldest =
      [...state.tasks].find(([, capture]) => !capture.output.active)?.[0] ??
      state.tasks.keys().next().value;
    if (oldest === undefined) break;
    state.tasks.delete(oldest);
  }
}
state.cleanup ??= setInterval(prune, REPLAY_MS);
state.cleanup.unref?.();
function notify(
  taskId: string,
  reason: "start" | "update" | "persist" = "update",
) {
  for (const listener of state.listeners) {
    try {
      listener(taskId, reason);
    } catch {
      state.listeners.delete(listener);
    }
  }
}
export function subscribeTaskOutput(listener: Listener) {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}
/** Also wakes observers after a ledger or conversation persistence commit. */
export function notifyTaskOutput(taskId: string) {
  notify(taskId, "persist");
}
export function startTaskOutput(
  taskId: string,
  metadata: Pick<
    LiveTaskOutput,
    "startedAt" | "runtimeKind" | "modelName"
  > = {},
) {
  prune();
  state.tasks.set(taskId, {
    output: {
      taskId,
      text: "",
      activities: [],
      active: true,
      done: false,
      executionStage: "preparing",
      startedAt: Date.now(),
      ...metadata,
    },
    secrets: [],
    sequence: 0,
    expires: Date.now() + ACTIVE_TTL_MS,
  });
  prune();
  notify(taskId, "start");
}
export function configureTaskOutput(
  taskId: string,
  secrets: readonly string[],
  modelName: string,
) {
  const capture = state.tasks.get(taskId);
  if (!capture) return;
  capture.secrets = secrets.filter(Boolean);
  capture.output.modelName = redactText(modelName, capture.secrets);
}
export function taskOutput(taskId: string): LiveTaskOutput | null {
  const capture = state.tasks.get(taskId);
  if (!capture || capture.expires <= Date.now()) return null;
  return {
    ...capture.output,
    text: redactText(capture.output.text, capture.secrets),
    activities: capture.output.activities.map((activity) => ({
      ...activity,
      ...(activity.text
        ? { text: redactText(activity.text, capture.secrets) }
        : {}),
      // Offsets index the raw text; map them onto the redacted text.
      ...(activity.textOffset === undefined
        ? {}
        : {
            textOffset: redactText(
              capture.output.text.slice(0, activity.textOffset),
              capture.secrets,
            ).length,
          }),
    })),
  };
}
function captureFor(taskId: string) {
  const capture = state.tasks.get(taskId);
  if (!capture?.output.active) return null;
  capture.expires = Date.now() + ACTIVE_TTL_MS;
  return capture;
}
export function publishTaskText(taskId: string, delta: string) {
  const capture = captureFor(taskId);
  if (!capture || !delta) return;
  if (capture.output.text.length + delta.length > MAX_TEXT)
    capture.output.truncated = true;
  capture.output.text = (capture.output.text + delta).slice(0, MAX_TEXT);
  notify(taskId);
}
export function publishTaskStage(taskId: string, stage: AgentExecutionStage) {
  const capture = captureFor(taskId);
  if (!capture || capture.output.executionStage === stage) return;
  capture.output.executionStage = stage;
  notify(taskId);
}
/** The model actually answering, e.g. after a fallback switch. */
export function publishTaskModel(taskId: string, modelName: string) {
  const capture = captureFor(taskId);
  if (!capture) return;
  const safe = redactText(modelName, capture.secrets);
  if (capture.output.modelName === safe) return;
  capture.output.modelName = safe;
  notify(taskId);
}
export function publishTaskMessageQueue(
  taskId: string,
  queue: AgentMessageQueue,
) {
  const capture = captureFor(taskId);
  if (!capture) return;
  capture.output.messageQueue = {
    pendingMessageCount: queue.pendingMessageCount,
    messages: queue.messages.map((message) => ({
      ...message,
      text: redactText(message.text, capture.secrets),
    })),
  };
  notify(taskId);
}

export function resetTaskMessageOutput(taskId: string) {
  const capture = captureFor(taskId);
  if (!capture) return;
  capture.output.text = "";
  capture.output.activities = [];
  capture.reasoningId = undefined;
  notify(taskId);
}
function safeValue(
  value: unknown,
  secrets: readonly string[],
  toolName?: string,
) {
  if (value === undefined) return undefined;
  const data = sanitizeLog(value, secrets).data;
  const text = JSON.stringify(data);
  // Keep only the browser's single, bounded JPEG image intact; ordinary logs
  // and untrusted oversized tool values retain the existing 2 KiB budget.
  const imageResult =
    toolName === "browser" && text.length <= 206_000
      ? typeof data === "string"
        ? parseImageResult(data)
        : data
      : undefined;
  const image =
    imageResult && typeof imageResult === "object" && "content" in imageResult
      ? imageResult.content
      : undefined;
  const part =
    Array.isArray(image) && image.length === 1 ? image[0] : undefined;
  const boundedImage =
    part?.type === "image" &&
    part.mimeType === "image/jpeg" &&
    typeof part.data === "string" &&
    part.data.length <= 204_800 &&
    part.data.startsWith("/9j/") &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(part.data);
  return boundedImage || text.length <= MAX_VALUE
    ? data
    : `${redactText(text.slice(0, MAX_VALUE - 1), secrets)}…`;
}
function parseImageResult(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
export function publishTaskActivity(
  taskId: string,
  activity: SandboxRuntimeActivity,
) {
  const capture = captureFor(taskId);
  if (!capture) return;
  const activities = capture.output.activities;
  const source = activity.source
    ? {
        subagentId: redactText(
          activity.source.subagentId.slice(0, 256),
          capture.secrets,
        ),
        ...(activity.source.subagentVersionId
          ? {
              subagentVersionId: redactText(
                activity.source.subagentVersionId.slice(0, 256),
                capture.secrets,
              ),
            }
          : {}),
        ...(activity.source.subagentName
          ? {
              subagentName: redactText(
                activity.source.subagentName.slice(0, 256),
                capture.secrets,
              ),
            }
          : {}),
        ...(activity.source.parentToolCallId
          ? {
              parentToolCallId: redactText(
                activity.source.parentToolCallId.slice(0, 256),
                capture.secrets,
              ),
            }
          : {}),
        ...(activity.source.depth === undefined
          ? {}
          : { depth: activity.source.depth }),
      }
    : undefined;
  if (capture.reasoningId) {
    const reasoning = activities.find(
      (item) => item.id === capture.reasoningId,
    );
    if (
      reasoning &&
      (activity.type !== "reasoning" ||
        reasoning.source?.subagentId !== source?.subagentId)
    ) {
      reasoning.status = "completed";
      capture.reasoningId = undefined;
    }
  }
  let next: LiveTaskActivity;
  if (activity.type === "reasoning") {
    if (!capture.reasoningId)
      capture.reasoningId = `reasoning:${++capture.sequence}`;
    const previous = activities.find((item) => item.id === capture.reasoningId);
    const text = (previous?.text ?? "") + (activity.delta ?? "");
    next = {
      id: capture.reasoningId,
      type: "reasoning",
      status: activity.status,
      text: text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text,
      ...(source ? { source } : {}),
      ...(previous?.textOffset === undefined
        ? {}
        : { textOffset: previous.textOffset }),
    };
    if (activity.status !== "running") capture.reasoningId = undefined;
  } else {
    if (!activity.toolCallId) return;
    const toolCallId = activity.toolCallId.slice(0, 256);
    const id = source
      ? `tool:${JSON.stringify([source.subagentId, toolCallId])}`
      : `tool:${toolCallId}`;
    const previous = activities.find((item) => item.id === id);
    next = {
      ...previous,
      id,
      type: "tool",
      status: activity.status,
      toolCallId,
      toolName: redactText(
        (activity.toolName ?? previous?.toolName ?? "Tool").slice(0, 512),
        capture.secrets,
      ),
      ...(source ? { source } : {}),
      ...(activity.durationMs === undefined
        ? {}
        : { durationMs: activity.durationMs }),
      ...(activity.input === undefined
        ? {}
        : { input: safeValue(activity.input, capture.secrets) }),
      ...(activity.output === undefined
        ? {}
        : {
            output: safeValue(
              activity.output,
              capture.secrets,
              activity.toolName ?? previous?.toolName,
            ),
          }),
      ...(activity.patch === undefined
        ? {}
        : {
            patch: redactText(activity.patch, capture.secrets),
            truncated: activity.truncated === true,
            firstChangedLine: activity.firstChangedLine,
          }),
      isError: activity.isError === true || activity.status === "failed",
    };
  }
  const index = activities.findIndex((item) => item.id === next.id);
  if (index < 0) {
    if (activities.length >= MAX_ACTIVITIES) activities.shift();
    activities.push({ ...next, textOffset: capture.output.text.length });
  } else activities[index] = next;
  notify(taskId);
}
/** Called using committed ledger state, not merely when the runtime returns. */
export function finishTaskOutput(
  taskId: string,
  status: "completed" | "failed" | "cancelled",
) {
  const capture = state.tasks.get(taskId);
  if (!capture) {
    notify(taskId, "persist");
    return;
  }
  if (capture.output.done) {
    notify(taskId, "persist");
    return;
  }
  capture.output.active = false;
  capture.output.done = true;
  capture.output.executionStage = undefined;
  capture.output.messageQueue = { messages: [], pendingMessageCount: 0 };
  for (const activity of capture.output.activities)
    if (activity.status === "running") activity.status = status;
  const runtime: LiveTaskActivity = {
    id: "runtime:final",
    type: "runtime",
    status,
    textOffset: capture.output.text.length,
  };
  if (capture.output.activities.length >= MAX_ACTIVITIES)
    capture.output.activities.shift();
  capture.output.activities.push(runtime);
  capture.expires = Date.now() + REPLAY_MS;
  notify(taskId, "persist");
}
