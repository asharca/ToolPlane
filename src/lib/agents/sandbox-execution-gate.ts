import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Shared by chat, Work and native A2A. Each session (conversation/context) runs
 * one turn at a time; different sessions of one Agent sandbox run concurrently
 * in their own workspace roots. Lifecycle and maintenance hold the whole sandbox.
 * Admission limits live in agent-execution-gate (admin concurrency settings).
 */
type Lease = { sandboxId: string; token: symbol; session?: string };
type Owner = { exclusive?: symbol; sessions: Map<string, symbol> };
type State = {
  owners: Map<string, Owner>;
  context: AsyncLocalStorage<Lease>;
  steps?: Map<string, Promise<void>>;
};
const root = globalThis as typeof globalThis & {
  __sandboxExecutionLeases?: State;
};
// ponytail: process-local leases rely on TP's single runtime owner.
root.__sandboxExecutionLeases ??= {
  owners: new Map(),
  context: new AsyncLocalStorage<Lease>(),
};
const state: State = root.__sandboxExecutionLeases;
state.steps ??= new Map();
const steps = state.steps;
/**
 * FIFO for short steps that concurrent sessions of one sandbox must not
 * interleave (shared runtime install, session binding writes). Turns stay parallel.
 */
export function serializeSandboxStep<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const result = (steps.get(key) ?? Promise.resolve()).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  steps.set(key, tail);
  void tail.then(() => {
    if (steps.get(key) === tail) steps.delete(key);
  });
  return result;
}
export class SandboxExecutionBusyError extends Error {
  constructor() {
    super("The Agent sandbox is already executing another turn.");
  }
}
/** Any session turn or whole-sandbox operation is active. */
export function sandboxExecutionBusy(sandboxId: string): boolean {
  const owner = state.owners.get(sandboxId);
  return Boolean(owner && (owner.exclusive || owner.sessions.size));
}
/** A new task must reserve an idle session; only its own host calls may reenter. */
export function sandboxSessionBusy(
  sandboxId: string,
  session: string,
): boolean {
  const owner = state.owners.get(sandboxId);
  return Boolean(owner && (owner.exclusive || owner.sessions.has(session)));
}
function inherited(sandboxId: string): Lease | undefined {
  const lease = state.context.getStore();
  const owner = lease?.sandboxId === sandboxId && state.owners.get(sandboxId);
  if (!lease || !owner) return undefined;
  const live = lease.session
    ? owner.sessions.get(lease.session) === lease.token ||
      owner.exclusive === lease.token
    : owner.exclusive === lease.token;
  return live ? lease : undefined;
}
function owner(sandboxId: string): Owner {
  let entry = state.owners.get(sandboxId);
  if (!entry) {
    entry = { sessions: new Map() };
    state.owners.set(sandboxId, entry);
  }
  return entry;
}
function release(sandboxId: string, clear: (entry: Owner) => void) {
  const entry = state.owners.get(sandboxId);
  if (!entry) return;
  clear(entry);
  if (!entry.exclusive && !entry.sessions.size) state.owners.delete(sandboxId);
}
function run<T>(
  lease: Lease,
  operation: () => Promise<T>,
  clear: (entry: Owner) => void,
): Promise<T> {
  return state.context.run(lease, async () => {
    try {
      return await operation();
    } finally {
      release(lease.sandboxId, clear);
    }
  });
}
/**
 * Whole-sandbox lifecycle or maintenance. Its own calls may reenter; the only
 * running session may upgrade itself, otherwise any active session is busy.
 */
export function withSandboxExecutionLease<T>(
  sandboxId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const current = inherited(sandboxId);
  const entry = state.owners.get(sandboxId);
  if (current && entry?.exclusive === current.token) return operation();
  if (entry?.exclusive || (entry?.sessions.size ?? 0) > (current ? 1 : 0))
    throw new SandboxExecutionBusyError();
  const token = current?.token ?? Symbol("sandbox-execution");
  owner(sandboxId).exclusive = token;
  return run({ sandboxId, token }, operation, (held) => {
    if (held.exclusive === token) held.exclusive = undefined;
  });
}
/** One turn per session; other sessions of the same sandbox keep running. */
export function withSandboxSessionLease<T>(
  sandboxId: string,
  session: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (inherited(sandboxId)) return operation();
  if (sandboxSessionBusy(sandboxId, session))
    throw new SandboxExecutionBusyError();
  const token = Symbol("sandbox-session");
  owner(sandboxId).sessions.set(session, token);
  return run({ sandboxId, token, session }, operation, (held) => {
    if (held.sessions.get(session) === token) held.sessions.delete(session);
  });
}
