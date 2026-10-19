import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { getAgentConcurrencySettings } from "@/lib/admin/settings";
import type { AgentConcurrencySettings } from "@/lib/admin/settings";

type Lease = { key: string; agentId: string };
type Pending = {
  lease: Lease;
  wait: boolean;
  signal?: AbortSignal;
  resolve: (lease: Lease) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
};
type Gate = {
  active: Map<string, Lease>;
  pending: Pending[];
  maintenance: Map<string, symbol>;
  maintenanceContext: AsyncLocalStorage<ReadonlyMap<string, symbol>>;
  context: AsyncLocalStorage<Lease>;
  draining: boolean;
  dirty: boolean;
};
const globals = globalThis as typeof globalThis & {
  __agentExecutionGate?: Gate;
};
// ponytail: process-local admission relies on TP's single runtime owner; use shared leases before multi-owner execution.
globals.__agentExecutionGate ??= {
  active: new Map(),
  pending: [],
  maintenance: new Map(),
  maintenanceContext: new AsyncLocalStorage<ReadonlyMap<string, symbol>>(),
  context: new AsyncLocalStorage<Lease>(),
  draining: false,
  dirty: false,
};
const gate = globals.__agentExecutionGate;

export class AgentExecutionBusyError extends Error {
  constructor() {
    super("Agent execution capacity is busy. The task has not started.");
    this.name = "AgentExecutionBusyError";
  }
}

function removePending(pending: Pending) {
  const index = gate.pending.indexOf(pending);
  if (index !== -1) gate.pending.splice(index, 1);
  pending.signal?.removeEventListener("abort", pending.onAbort);
}

async function drain() {
  if (gate.draining) return;
  gate.draining = true;
  try {
    while (gate.dirty && gate.pending.length) {
      gate.dirty = false;
      let limits: AgentConcurrencySettings;
      try {
        limits = await getAgentConcurrencySettings();
      } catch (error) {
        for (const pending of [...gate.pending]) {
          removePending(pending);
          pending.reject(error);
        }
        return;
      }
      for (const pending of [...gate.pending]) {
        if (!gate.pending.includes(pending)) continue;
        const { lease } = pending;
        let activeForAgent = 0;
        for (const active of gate.active.values()) {
          if (active.agentId === lease.agentId) activeForAgent++;
        }
        const available =
          !gate.maintenance.has(lease.agentId) &&
          !gate.active.has(lease.key) &&
          gate.active.size < limits.maxTotal &&
          activeForAgent < limits.maxPerAgent;
        if (!available && pending.wait) continue;
        removePending(pending);
        if (available) {
          gate.active.set(lease.key, lease);
          pending.resolve(lease);
        } else {
          pending.reject(new AgentExecutionBusyError());
        }
      }
    }
  } finally {
    gate.draining = false;
  }
}

export function refreshAgentExecutionLimits(): void {
  gate.dirty = true;
  void drain();
}

export function agentExecutionBusy(agentId: string): boolean {
  return (
    gate.maintenance.has(agentId) ||
    [...gate.active.values()].some((lease) => lease.agentId === agentId) ||
    gate.pending.some((pending) => pending.lease.agentId === agentId)
  );
}

export async function withAgentExecutionLease<T>(
  input: {
    agentId: string;
    sessionId: string;
    signal?: AbortSignal;
    wait?: boolean;
  },
  fn: () => Promise<T>,
): Promise<T> {
  input.signal?.throwIfAborted();
  const key = JSON.stringify([input.agentId, input.sessionId]);
  const inherited = gate.context.getStore();
  if (inherited?.key === key && gate.active.get(key) === inherited) return fn();

  const lease = await new Promise<Lease>((resolve, reject) => {
    const pending: Pending = {
      lease: { key, agentId: input.agentId },
      wait: input.wait !== false,
      signal: input.signal,
      resolve,
      reject,
      onAbort: () => {
        removePending(pending);
        reject(input.signal?.reason);
        refreshAgentExecutionLimits();
      },
    };
    gate.pending.push(pending);
    input.signal?.addEventListener("abort", pending.onAbort, { once: true });
    refreshAgentExecutionLimits();
  });
  try {
    input.signal?.throwIfAborted();
    return await gate.context.run(lease, fn);
  } finally {
    if (gate.active.get(key) === lease) gate.active.delete(key);
    refreshAgentExecutionLimits();
  }
}

export async function withAgentMaintenanceLease<T>(
  agentId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const inherited = gate.maintenanceContext.getStore();
  const inheritedToken = inherited?.get(agentId);
  if (inheritedToken && gate.maintenance.get(agentId) === inheritedToken)
    return fn();
  if (agentExecutionBusy(agentId)) throw new AgentExecutionBusyError();
  const token = Symbol(agentId);
  gate.maintenance.set(agentId, token);
  const context = new Map(inherited);
  context.set(agentId, token);
  try {
    return await gate.maintenanceContext.run(context, fn);
  } finally {
    if (gate.maintenance.get(agentId) === token)
      gate.maintenance.delete(agentId);
    refreshAgentExecutionLimits();
  }
}
