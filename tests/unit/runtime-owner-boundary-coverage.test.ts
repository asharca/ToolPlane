// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Fresh imports are required per case: the owner stores a module-level shutdown promise.
const m = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  channel: vi.fn(),
  connector: vi.fn(),
  dashboard: vi.fn(),
  processes: vi.fn(),
  coordinator: vi.fn(),
  worker: vi.fn(),
}));
let connection: EventEmitter;
vi.mock("pg", () => ({
  Client: class extends EventEmitter {
    constructor() {
      super();
      connection = this;
    }
    connect = m.connect;
    query = m.query;
    end = m.end;
  },
}));
vi.mock("@/lib/work/coordinator", () => ({
  stopWorkCoordinator: m.coordinator,
}));
vi.mock("@/lib/a2a/worker", () => ({ stopA2AWorker: m.worker }));
vi.mock("@/lib/agents/channel-runtime", () => ({
  shutdownAgentChannelRunners: m.channel,
}));
vi.mock("@/lib/sandboxes/connector-broker", () => ({
  shutdownConnectorBroker: m.connector,
}));
vi.mock("@/lib/agents/hermes/dashboard-broker", () => ({
  closeHermesDashboardBroker: m.dashboard,
}));
vi.mock("@/lib/process/supervisor", () => ({
  shutdownOwnedProcesses: m.processes,
}));
const g = globalThis as typeof globalThis & {
  __toolplaneOwnerLease?: unknown;
  __toolplaneShutdown?: unknown;
  __toolplaneStopTimers?: () => void;
};
describe("runtime owner recovery and shutdown boundaries", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    delete g.__toolplaneOwnerLease;
    delete g.__toolplaneShutdown;
    delete g.__toolplaneStopTimers;
    m.connect.mockResolvedValue(undefined);
    m.end.mockResolvedValue(undefined);
    m.query.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith("SELECT pg_try") ? [{ locked: true }] : [],
    }));
    for (const mock of [m.channel, m.connector, m.dashboard, m.processes])
      mock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    delete g.__toolplaneOwnerLease;
    delete g.__toolplaneShutdown;
    delete g.__toolplaneStopTimers;
  });
  it("recovers once under maintenance authority and shares shutdown completion", async () => {
    const { startRuntimeOwner, shutdownRuntimeOwner } = await import(
      "@/lib/runtime/owner"
    );
    const { ownership } = await import("@/lib/runtime/ownership-state");
    const recover = vi.fn(async () => {
      expect(ownership.status).toBe("recovering");
      expect(ownership.canOperate()).toBe(true);
    });
    await startRuntimeOwner(recover);
    await startRuntimeOwner(recover);
    expect(recover).toHaveBeenCalledOnce();
    expect(ownership.status).toBe("ready");
    const first = shutdownRuntimeOwner();
    expect(shutdownRuntimeOwner()).toBe(first);
    expect(await first).toBe(true);
    expect(ownership.status).toBe("stopped");
    expect(m.query.mock.calls.some(([sql]) => sql.startsWith("DELETE"))).toBe(
      true,
    );
    expect(m.end).toHaveBeenCalledOnce();
  });
  it("preserves recovery markers when startup fails", async () => {
    const { startRuntimeOwner } = await import("@/lib/runtime/owner");
    const { ownership } = await import("@/lib/runtime/ownership-state");
    const timers = vi.fn();
    g.__toolplaneStopTimers = timers;
    await expect(
      startRuntimeOwner(async () => {
        throw new Error("recovery failed");
      }),
    ).rejects.toThrow("recovery failed");
    expect(ownership.status).toBe("blocked");
    expect(ownership.uncertain).toBe(true);
    expect(timers).toHaveBeenCalled();
    expect(m.query.mock.calls.some(([sql]) => sql.startsWith("DELETE"))).toBe(
      false,
    );
  });
  it("blocks when the lease connection fails before recovery", async () => {
    const { startRuntimeOwner } = await import("@/lib/runtime/owner");
    const { ownership } = await import("@/lib/runtime/ownership-state");
    m.connect.mockRejectedValue(new Error("connect failed"));
    const recover = vi.fn();
    await expect(startRuntimeOwner(recover)).rejects.toThrow("connect failed");
    expect(recover).not.toHaveBeenCalled();
    expect(ownership.status).toBe("blocked");
    expect(m.end).not.toHaveBeenCalled();
  });
  it("fails closed when ownership is lost immediately after acquiring", async () => {
    const { startRuntimeOwner } = await import("@/lib/runtime/owner");
    const { ownership } = await import("@/lib/runtime/ownership-state");
    m.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("INSERT")) connection.emit("error", new Error("lost"));
      return {
        rows: sql.startsWith("SELECT pg_try") ? [{ locked: true }] : [],
      };
    });
    await expect(startRuntimeOwner(vi.fn())).rejects.toThrow(
      "Runtime ownership connection was lost",
    );
    expect(ownership.abort.signal.aborted).toBe(true);
    expect(ownership.status).toBe("blocked");
  });
  it("reacts to connection end by stopping timers and shutting down without clean marker deletion", async () => {
    const { startRuntimeOwner, shutdownRuntimeOwner } = await import(
      "@/lib/runtime/owner"
    );
    const { ownership } = await import("@/lib/runtime/ownership-state");
    const timers = vi.fn();
    g.__toolplaneStopTimers = timers;
    await startRuntimeOwner(async () => undefined);
    connection.emit("end");
    expect(await shutdownRuntimeOwner()).toBe(false);
    expect(timers).toHaveBeenCalled();
    expect(ownership.abort.signal.aborted).toBe(true);
    expect(m.query.mock.calls.some(([sql]) => sql.startsWith("DELETE"))).toBe(
      false,
    );
  });
  it.each(["channel", "processes"] as const)(
    "preserves unclean shutdown if %s cleanup fails",
    async (name) => {
      const { startRuntimeOwner, shutdownRuntimeOwner } = await import(
        "@/lib/runtime/owner"
      );
      const { ownership } = await import("@/lib/runtime/ownership-state");
      await startRuntimeOwner(async () => undefined);
      m[name].mockRejectedValue(new Error("failed"));
      expect(await shutdownRuntimeOwner()).toBe(false);
      expect(ownership.uncertain).toBe(true);
      expect(m.query.mock.calls.some(([sql]) => sql.startsWith("DELETE"))).toBe(
        false,
      );
    },
  );
  it("times out cleanup without claiming the runtime drained", async () => {
    const { startRuntimeOwner, shutdownRuntimeOwner } = await import(
      "@/lib/runtime/owner"
    );
    const { ownership } = await import("@/lib/runtime/ownership-state");
    await startRuntimeOwner(async () => undefined);
    m.channel.mockReturnValue(Promise.withResolvers<void>().promise);
    const stopped = shutdownRuntimeOwner();
    await vi.advanceTimersByTimeAsync(40001);
    expect(await stopped).toBe(false);
    expect(ownership.abort.signal.aborted).toBe(true);
    expect(ownership.uncertain).toBe(true);
  });
  it.each(["invalid", 123])(
    "rejects malformed prior owner markers %j",
    async (value) => {
      const { RuntimeOwnerLease } = await import("@/lib/runtime/owner");
      const client = {
        connect: m.connect,
        query: m.query,
        end: m.end,
        on: vi.fn(),
      };
      m.query
        .mockResolvedValueOnce({ rows: [{ locked: true }] })
        .mockResolvedValueOnce({ rows: [{ value }] });
      const lease = new RuntimeOwnerLease(
        client as unknown as ConstructorParameters<typeof RuntimeOwnerLease>[0],
      );
      await expect(lease.acquire()).rejects.toThrow(
        "Invalid runtime owner recovery marker",
      );
      await lease.release(false);
      expect(m.end).toHaveBeenCalledOnce();
    },
  );
  it("closes failed marker deletions and tolerates a connection close error", async () => {
    const { RuntimeOwnerLease } = await import("@/lib/runtime/owner");
    const client = {
      connect: m.connect,
      query: m.query,
      end: m.end,
      on: vi.fn(),
    };
    const lease = new RuntimeOwnerLease(
      client as unknown as ConstructorParameters<typeof RuntimeOwnerLease>[0],
    );
    await lease.acquire();
    m.query.mockRejectedValueOnce(new Error("delete failed"));
    m.end.mockRejectedValueOnce(new Error("already ended"));
    await expect(lease.release(true)).rejects.toThrow("delete failed");
    await lease.release(false);
    expect(m.end).toHaveBeenCalledOnce();
  });
});
