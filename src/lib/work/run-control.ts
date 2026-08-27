import 'server-only';

type Registry = Map<string, AbortController>;

export type WorkOutputSnapshot = {
  text: string;
  activities: WorkOutputActivity[];
  active: boolean;
  done: boolean;
};

export type WorkOutputActivity = {
  id: string;
  type: 'runtime' | 'reasoning' | 'tool';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  runtimeKind?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
};

export type WorkOutputEvent =
  | { type: 'start'; snapshot: WorkOutputSnapshot }
  | { type: 'delta'; delta: string; snapshot: WorkOutputSnapshot }
  | { type: 'activity'; activity: WorkOutputActivity; snapshot: WorkOutputSnapshot }
  | { type: 'done'; snapshot: WorkOutputSnapshot };

type WorkOutputListener = (event: WorkOutputEvent) => void;
type WorkOutputChannel = WorkOutputSnapshot & {
  listeners: Set<WorkOutputListener>;
  cleanup?: ReturnType<typeof setTimeout>;
};
type OutputRegistry = Map<string, WorkOutputChannel>;

const globalRegistry = globalThis as unknown as {
  __workRunControllers?: Registry;
  __workOutputChannels?: OutputRegistry;
};
const controllers = globalRegistry.__workRunControllers ?? new Map<string, AbortController>();
// ponytail: process-local replay matches the coordinator; use shared pub/sub when horizontally scaling.
const outputChannels = globalRegistry.__workOutputChannels ?? new Map<string, WorkOutputChannel>();
globalRegistry.__workRunControllers = controllers;
globalRegistry.__workOutputChannels = outputChannels;

function outputChannel(workSessionId: string): WorkOutputChannel {
  let channel = outputChannels.get(workSessionId);
  if (!channel) {
    channel = { text: '', activities: [], active: false, done: false, listeners: new Set() };
    outputChannels.set(workSessionId, channel);
  }
  return channel;
}

function outputSnapshot(channel: WorkOutputChannel): WorkOutputSnapshot {
  return {
    text: channel.text,
    activities: channel.activities.map((activity) => ({ ...activity })),
    active: channel.active,
    done: channel.done,
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

export function startWorkOutput(workSessionId: string) {
  const channel = outputChannel(workSessionId);
  if (channel.cleanup) clearTimeout(channel.cleanup);
  channel.cleanup = undefined;
  channel.text = '';
  channel.activities = [];
  channel.active = true;
  channel.done = false;
  notifyOutput(channel, { type: 'start', snapshot: outputSnapshot(channel) });
}

export function publishWorkActivity(workSessionId: string, activity: WorkOutputActivity) {
  const channel = outputChannel(workSessionId);
  if (channel.cleanup) clearTimeout(channel.cleanup);
  channel.cleanup = undefined;
  const index = channel.activities.findIndex((item) => item.id === activity.id);
  const next = index < 0 ? activity : { ...channel.activities[index], ...activity };
  if (index < 0) channel.activities.push(next);
  else channel.activities[index] = next;
  channel.active = true;
  channel.done = false;
  notifyOutput(channel, { type: 'activity', activity: { ...next }, snapshot: outputSnapshot(channel) });
}

export function publishWorkOutput(workSessionId: string, delta: string) {
  if (!delta) return;
  const channel = outputChannel(workSessionId);
  if (channel.cleanup) clearTimeout(channel.cleanup);
  channel.cleanup = undefined;
  channel.text += delta;
  channel.active = true;
  channel.done = false;
  notifyOutput(channel, { type: 'delta', delta, snapshot: outputSnapshot(channel) });
}

export function finishWorkOutput(workSessionId: string) {
  const channel = outputChannel(workSessionId);
  if (channel.done && !channel.active) return;
  channel.active = false;
  channel.done = true;
  notifyOutput(channel, { type: 'done', snapshot: outputSnapshot(channel) });
  // Keep a short replay window for clients that reconnect as the DB update settles.
  if (channel.cleanup) clearTimeout(channel.cleanup);
  channel.cleanup = setTimeout(() => {
    if (outputChannels.get(workSessionId) === channel) outputChannels.delete(workSessionId);
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

export function registerWorkRun(workSessionId: string, controller: AbortController) {
  controllers.set(workSessionId, controller);
}

export function unregisterWorkRun(workSessionId: string, controller: AbortController) {
  if (controllers.get(workSessionId) === controller) controllers.delete(workSessionId);
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
