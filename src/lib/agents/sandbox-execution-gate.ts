import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Shared by chat, Work and native A2A: one writer per configured local sandbox. */
type Lease = { sandboxId: string; token: symbol };
type State = { owners: Map<string, symbol>; context: AsyncLocalStorage<Lease> };
const root = globalThis as typeof globalThis & { __sandboxExecutionGate?: State };
const state: State = root.__sandboxExecutionGate ??= { owners: new Map(), context: new AsyncLocalStorage<Lease>() };
export class SandboxExecutionBusyError extends Error {
  constructor() { super('The Agent sandbox is already executing another turn.'); }
}
export function withSandboxExecutionLease<T>(sandboxId: string, operation: () => Promise<T>): Promise<T> {
  const inherited = state.context.getStore();
  if (inherited?.sandboxId === sandboxId && state.owners.get(sandboxId) === inherited.token) return operation();
  if (state.owners.has(sandboxId)) throw new SandboxExecutionBusyError();
  const token = Symbol('sandbox-execution');
  state.owners.set(sandboxId, token);
  return state.context.run({ sandboxId, token }, async () => {
    try { return await operation(); }
    finally { if (state.owners.get(sandboxId) === token) state.owners.delete(sandboxId); }
  });
}
