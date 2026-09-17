import { AsyncLocalStorage } from 'node:async_hooks';

export type OwnerStatus = 'idle' | 'acquiring' | 'recovering' | 'ready' | 'draining' | 'blocked' | 'lost' | 'stopped';
export class RuntimeUnavailableError extends Error {
  constructor() { super('Runtime owner is not ready. Retry after recovery.'); }
}
export class RuntimeOwnershipState {
  status: OwnerStatus = 'idle';
  pending = 0;
  uncertain = false;
  readonly abort = new AbortController();
  readonly maintenance = new AsyncLocalStorage<boolean>();
  canOperate(stop = false) {
    return this.status === 'ready' || (this.maintenance.getStore() === true
      && (this.status === 'recovering' || (stop && this.status === 'draining')));
  }
  assert(stop = false) { if (!this.canOperate(stop)) throw new RuntimeUnavailableError(); }
  ready() { if (this.status !== 'recovering') throw new RuntimeUnavailableError(); this.status = 'ready'; }
  lose() { this.status = 'lost'; this.uncertain = true; this.abort.abort(); }
  enter(stop = false): () => void {
    this.assert(stop); this.pending++;
    let released = false;
    return () => { if (!released) { released = true; this.pending--; } };
  }
  async run<T>(operation: () => Promise<T>, stop = false): Promise<T> {
    this.assert(stop);
    this.pending++;
    try { return await operation(); } finally { this.pending--; }
  }
  async drain(timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (this.pending && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
    if (this.pending) { this.uncertain = true; this.abort.abort(); }
    return this.pending === 0 && !this.uncertain;
  }
}
const globals = globalThis as typeof globalThis & { __toolplaneRuntimeOwnership?: RuntimeOwnershipState };
export const ownership = globals.__toolplaneRuntimeOwnership ??= new RuntimeOwnershipState();
// Unit/integration fixtures do not boot Next. Ownership tests instantiate the
// state machine (or set TOOLPLANE_TEST_RUNTIME_OWNER=1) to exercise real gates.
function fixture() { return process.env.NODE_ENV === 'test' && process.env.VITEST === 'true' && process.env.TOOLPLANE_TEST_RUNTIME_OWNER !== '1'; }
export function assertRuntimeOwner(stop = false) { if (!fixture()) ownership.assert(stop); }
export function runtimeIsReady() { return fixture() || ownership.status === 'ready'; }
export function runtimeCanOperate(stop = false) { return fixture() || ownership.canOperate(stop); }
export function runtimeAbortSignal(): AbortSignal | undefined { return fixture() ? undefined : ownership.abort.signal; }
export function markRuntimeUncertain() { if (!fixture()) ownership.uncertain = true; }
export function trackRuntimeOperation<T>(operation: () => Promise<T>, stop = false) {
  return fixture() ? operation() : ownership.run(operation, stop);
}
export function runtimeRequestUnavailable(route: string, method: string): boolean {
  if (fixture() || ownership.status === 'ready') return false;
  // Existing signed runtime callbacks may be needed while startup recovers their owner.
  if (ownership.status === 'recovering' && /\/api\/v1\/agent-runtimes?\//.test(route)) return false;
  const execution = /\/(?:agents|agent-runtimes?|agent-endpoints|mcp|work-sessions|connectors|sandboxes|attachments)(?:\/|$)/.test(route)
    || route.includes('/api/openai/v1/chat');
  return execution && (method !== 'GET' || /\/(?:events|terminal|runtime|dashboard|stream)(?:\/|$)/.test(route));
}

export function beginRuntimeOperation(stop = false): () => void {
  return fixture() ? () => undefined : ownership.enter(stop);
}

export function runtimeRequest<T>(route: string, method: string, operation: () => Promise<T>): Promise<T> {
  if (fixture() || runtimeRequestUnavailable(route, method)) return operation();
  const execution = /\/(?:agents|agent-runtimes?|agent-endpoints|mcp|work-sessions|connectors|sandboxes|attachments)(?:\/|$)/.test(route)
    || route.includes('/api/openai/v1/chat');
  if (!execution) return operation();
  // The callback handler still authenticates its signed runtime grant before
  // any downstream work. This only allows its owner's startup callbacks.
  if (ownership.status === 'recovering' && /\/api\/v1\/agent-runtimes?\//.test(route)) {
    return ownership.maintenance.run(true, () => ownership.run(operation));
  }
  if (ownership.status !== 'ready') return operation(); // read-only metadata
  return ownership.run(operation);
}
