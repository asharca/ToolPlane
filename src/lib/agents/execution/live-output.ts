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
/** Bounded so the settled projection stays well inside the task snapshot cap. */
const MAX_STAGE_MARKS = 512;
const REPLAY_MS = 60_000;
const ACTIVE_TTL_MS = 3_600_000;
/** A committed redaction cut keeps this much later text, so any match spanning it is already visible. */
const REDACTION_LAG = 4096;
/** Redacted `output.text`; text before raw offset `cut` is final and never redacted again. */
type RedactedText = {
  cut: number;
  prefix: string;
  /** Raw length `text` was computed for; raw text only grows until reset. */
  raw: number;
  text: string;
  /** Raw-length limit below which a failed cut is not retried. */
  retryAt: number;
};
type Capture = {
  output: LiveTaskOutput;
  secrets: readonly string[];
  /** Longest configured secret, including its JSON-escaped form. */
  secretSpan: number;
  redacted?: RedactedText;
  /** Raw text offset → redacted text offset, fixed once its prefix exists. */
  offsets: Map<number, number>;
  /** Activities are replaced, never mutated, so each projection is computed once. */
  projected: WeakMap<LiveTaskActivity, LiveTaskActivity>;
  reasoningId?: string;
  /** Top-level reply text split at tool calls and consumed interjections; never reset. */
  reply?: { segments: string[]; open: boolean; size: number };
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
    secretSpan: 0,
    offsets: new Map(),
    projected: new WeakMap(),
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
  capture.secretSpan = Math.max(
    0,
    ...capture.secrets.map((secret) => JSON.stringify(secret).length),
  );
  capture.output.modelName = redactText(modelName, capture.secrets);
  resetRedaction(capture);
}
function resetRedaction(capture: Capture) {
  capture.redacted = undefined;
  capture.offsets.clear();
  capture.projected = new WeakMap();
}
/** Equals redactText(output.text) while redacting only the text after the last final cut. */
function redactedText(capture: Capture) {
  const raw = capture.output.text;
  capture.redacted ??= {
    cut: 0,
    prefix: "",
    raw: 0,
    text: "",
    retryAt: 0,
  };
  const view = capture.redacted;
  if (view.raw === raw.length) return view.text;
  const lag = Math.max(REDACTION_LAG, capture.secretSpan);
  const limit = raw.length - lag;
  let tail: string | undefined;
  if (limit - view.cut >= lag && limit >= view.retryAt) {
    // Cut just after whitespace so ordinary tokens stay whole.
    let cut = limit;
    while (cut > view.cut && !/\s/.test(raw[cut - 1] ?? "")) cut--;
    tail = redactText(raw.slice(view.cut), capture.secrets);
    // A cut is final only when redacting either side alone matches redacting
    // both together; with `lag` later characters every spanning match is visible.
    const head = redactText(raw.slice(view.cut, cut), capture.secrets);
    const rest = redactText(raw.slice(cut), capture.secrets);
    if (cut === view.cut || head + rest !== tail) view.retryAt = limit + lag;
    else {
      view.prefix += head;
      view.cut = cut;
      tail = rest;
    }
  }
  view.raw = raw.length;
  view.text =
    view.prefix + (tail ?? redactText(raw.slice(view.cut), capture.secrets));
  return view.text;
}
/** Offsets index the raw text; map them onto the redacted text. */
function redactedOffset(capture: Capture, offset: number) {
  let mapped = capture.offsets.get(offset);
  if (mapped === undefined) {
    mapped =
      offset === capture.output.text.length
        ? redactedText(capture).length
        : redactText(capture.output.text.slice(0, offset), capture.secrets)
            .length;
    capture.offsets.set(offset, mapped);
  }
  return mapped;
}
function projectActivity(capture: Capture, activity: LiveTaskActivity) {
  let projected = capture.projected.get(activity);
  if (!projected) {
    projected = {
      ...activity,
      ...(activity.text
        ? { text: redactText(activity.text, capture.secrets) }
        : {}),
      ...(activity.textOffset === undefined
        ? {}
        : { textOffset: redactedOffset(capture, activity.textOffset) }),
    };
    capture.projected.set(activity, projected);
  }
  return projected;
}
/** Appends at the current text end, fixing its redacted offset while the prefix is cached. */
function pushActivity(capture: Capture, activity: LiveTaskActivity) {
  const activities = capture.output.activities;
  if (activities.length >= MAX_ACTIVITIES) {
    activities.shift();
    if (capture.offsets.size > MAX_ACTIVITIES * 2) {
      const kept = new Set(activities.map((item) => item.textOffset));
      for (const offset of capture.offsets.keys())
        if (!kept.has(offset)) capture.offsets.delete(offset);
    }
  }
  const textOffset = capture.output.text.length;
  redactedOffset(capture, textOffset);
  activities.push({ ...activity, textOffset });
}
/** Unchanged text and activities keep their identity, so observers diff cheaply. */
export function taskOutput(taskId: string): LiveTaskOutput | null {
  const capture = state.tasks.get(taskId);
  if (!capture || capture.expires <= Date.now()) return null;
  return {
    ...capture.output,
    text: redactedText(capture),
    activities: capture.output.activities.map((activity) =>
      projectActivity(capture, activity),
    ),
  };
}
/** Channel delivery: each segment before the last ended at a tool call or interjection. */
export function taskReplySegments(taskId: string): string[] | null {
  const capture = state.tasks.get(taskId);
  if (!capture || capture.expires <= Date.now()) return null;
  return (capture.reply?.segments ?? []).map((segment) =>
    redactText(segment, capture.secrets),
  );
}
function appendReply(capture: Capture, delta: string) {
  capture.reply ??= { segments: [], open: false, size: 0 };
  const reply = capture.reply;
  const text = delta.slice(0, Math.max(0, MAX_TEXT - reply.size));
  if (!text) return;
  reply.size += text.length;
  if (reply.open) reply.segments[reply.segments.length - 1] += text;
  else reply.segments.push(text);
  reply.open = true;
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
  appendReply(capture, delta);
  notify(taskId);
}
export function publishTaskStage(taskId: string, stage: AgentExecutionStage) {
  const capture = captureFor(taskId);
  if (!capture || capture.output.executionStage === stage) return;
  capture.output.executionStage = stage;
  capture.output.stages ??= [];
  if (capture.output.stages.length < MAX_STAGE_MARKS)
    capture.output.stages.push({ stage, at: Date.now() });
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
  resetRedaction(capture);
  if (capture.reply) capture.reply.open = false;
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
  const now = Date.now();
  if (capture.reasoningId) {
    const index = activities.findIndex(
      (item) => item.id === capture.reasoningId,
    );
    const reasoning = activities[index];
    if (
      reasoning &&
      (activity.type !== "reasoning" ||
        reasoning.source?.subagentId !== source?.subagentId)
    ) {
      activities[index] = {
        ...reasoning,
        status: "completed",
        completedAt: reasoning.completedAt ?? now,
      };
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
      startedAt: previous?.startedAt ?? now,
      ...(activity.status === "running" ? {} : { completedAt: now }),
    };
    if (activity.status !== "running") capture.reasoningId = undefined;
  } else {
    if (!activity.toolCallId) return;
    const toolCallId = activity.toolCallId.slice(0, 256);
    const id = source
      ? `tool:${JSON.stringify([source.subagentId, toolCallId])}`
      : `tool:${toolCallId}`;
    const previous = activities.find((item) => item.id === id);
    const startedAt = previous?.startedAt ?? now;
    const completedAt =
      activity.status === "running"
        ? undefined
        : (previous?.completedAt ?? now);
    const durationMs =
      activity.durationMs ??
      previous?.durationMs ??
      (completedAt === undefined ? undefined : completedAt - startedAt);
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
      startedAt,
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(durationMs === undefined ? {} : { durationMs }),
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
    pushActivity(capture, next);
    if (next.type === "tool" && !source && capture.reply)
      capture.reply.open = false;
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
  const now = Date.now();
  capture.output.completedAt ??= now;
  capture.output.activities = capture.output.activities.map((activity) =>
    activity.status === "running"
      ? { ...activity, status, completedAt: activity.completedAt ?? now }
      : activity,
  );
  pushActivity(capture, { id: "runtime:final", type: "runtime", status });
  capture.expires = Date.now() + REPLAY_MS;
  notify(taskId, "persist");
}
