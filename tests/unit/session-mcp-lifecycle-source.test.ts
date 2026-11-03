// @vitest-environment node
import type { ChildProcess } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type * as SupervisorModule from "@/lib/process/supervisor";
import type * as CredentialsModule from "@/lib/process/mcp-credentials";
import type * as WorkspaceActions from "@/lib/workspace/actions";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  update: vi.fn(),
  workspace: vi.fn(),
  materialize: vi.fn(),
  removeVolume: vi.fn(),
  removeContainer: vi.fn(),
  deployment: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: mocks.spawn,
}));
vi.mock("@/lib/db", () => ({
  db: {
    deployment: { update: mocks.update, findFirst: mocks.deployment },
    workspace: { findFirst: mocks.workspace },
    agentServer: { findMany: async () => [] },
    chatAssistantMcpGrant: { findMany: async () => [] },
  },
}));
vi.mock("@/lib/runtime/ownership-state", () => ({
  assertRuntimeOwner: vi.fn(),
  runtimeAbortSignal: () => undefined,
  beginRuntimeOperation: () => () => undefined,
  trackRuntimeOperation: (operation: () => unknown) => operation(),
  markRuntimeUncertain: vi.fn(),
}));
vi.mock("@/lib/observability/events", () => ({
  recordEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/sandboxes/connector-broker", () => ({
  ensureConnectorBroker: vi.fn(),
}));
vi.mock("@/lib/admin/settings", () => ({
  resolveMcpStartupTimeoutSettings: async () => ({
    idleTimeoutMs: 300_000,
    maxTimeoutMs: 900_000,
    source: "database",
  }),
  resolveRemoteMcpPrivateHostsSettings: async () => ({
    value: "",
    source: "database",
  }),
}));
vi.mock("@/lib/process/deployment-config-volume", () => ({
  DEPLOYMENT_CONFIG_MOUNT_PATH: "/toolplane/config",
  configVolumeName: (id: string) => `private-config-${id}`,
  materializeDeploymentConfigVolume: mocks.materialize,
  removeDeploymentConfigVolume: mocks.removeVolume,
}));
vi.mock("@/lib/process/deployment-runtime-container", () => ({
  deploymentContainerName: (id: string) => `managed-${id}`,
  removeDeploymentContainer: mocks.removeContainer,
}));
vi.mock("@/lib/process/mcp-runtime-image", () => ({
  removeStaleSessionMcpCaptures: vi.fn(),
}));
vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: async () => ({ id: "operator" }),
}));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: async () => ({ id: "workspace" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/workspace/teardown", () => ({
  killWorkspaceProcesses: vi.fn(),
}));

type FakeChild = ChildProcess & { stdout: EventEmitter; stderr: EventEmitter };
const registryDir = path.join(
  os.tmpdir(),
  `toolplane-session-mcp-source-${process.pid}-${Date.now()}`,
);
const originalRegistryDir = process.env.TOOLPLANE_SUPERVISOR_DIR;
let supervisor: typeof SupervisorModule;
let credentials: typeof CredentialsModule;
let setDeploymentEnvAction: typeof WorkspaceActions.setDeploymentEnvAction;
let nextPid = 98_000_000;

function childProcess(): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: null,
    pid: nextPid++,
    exitCode: null,
    signalCode: null,
    killed: false,
  }) as unknown as FakeChild;
  child.kill = vi.fn((signal: NodeJS.Signals | number = "SIGTERM") => {
    queueMicrotask(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      Object.assign(child, { exitCode: 0, signalCode: signal, killed: true });
      child.emit("exit", 0, signal);
    });
    return true;
  });
  return child;
}

function resetGlobals() {
  const state = globalThis as typeof globalThis & {
    __mcpSupervisor?: unknown;
    __mcpSupervisorPersistQueues?: unknown;
    __mcpSupervisorLifecycleQueues?: unknown;
    __mcpSupervisorTombstones?: unknown;
    __mcpSupervisorWorkspaceTombstones?: unknown;
    __mcpSupervisorRuntime?: unknown;
    __mcpSupervisorSourceProcesses?: unknown;
    __mcpSupervisorProcessSources?: unknown;
    __mcpSupervisorRemoteSourceProcesses?: unknown;
  };
  delete state.__mcpSupervisor;
  delete state.__mcpSupervisorPersistQueues;
  delete state.__mcpSupervisorLifecycleQueues;
  delete state.__mcpSupervisorTombstones;
  delete state.__mcpSupervisorWorkspaceTombstones;
  delete state.__mcpSupervisorRuntime;
  delete state.__mcpSupervisorSourceProcesses;
  delete state.__mcpSupervisorProcessSources;
  delete state.__mcpSupervisorRemoteSourceProcesses;
}

const image = `example@sha256:${"a".repeat(64)}`;
const oldSpec = {
  kind: "bridge" as const,
  name: "Session MCP",
  command: "docker",
  args: ["run", image],
  image,
  env: {},
  containerEnv: { TOKEN: "old-token", OPTIONAL_TOKEN: "optional-token" },
};
const options = {
  awaitReady: false,
  workspaceId: "workspace",
  configSourceDeploymentId: "source",
};

function credentialForm(): FormData {
  const form = new FormData();
  form.set("workspace", "workspace");
  form.set("deploymentId", "source");
  form.set(
    "changes",
    JSON.stringify({
      set: { TOKEN: "rotated-token" },
      remove: ["OPTIONAL_TOKEN"],
    }),
  );
  return form;
}

function expectOnlyStoppedSourceWrites(): void {
  expect(mocks.update).toHaveBeenCalledWith({
    where: { id: "source" },
    data: { status: "stopped" },
  });
  expect(
    mocks.update.mock.calls.every(
      ([input]) =>
        input.where.id === "source" &&
        Object.keys(input.data).length === 1 &&
        input.data.status === "stopped",
    ),
  ).toBe(true);
}

beforeAll(async () => {
  process.env.TOOLPLANE_SUPERVISOR_DIR = registryDir;
  // This test exercises module initialization with an isolated registry path;
  // a static import would capture the real application's registry first.
  supervisor = await import("@/lib/process/supervisor");
  credentials = await import("@/lib/process/mcp-credentials");
  ({ setDeploymentEnvAction } = await import("@/lib/workspace/actions"));
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubEnv("AUTH_SECRET", "session-source-test-secret");
  mocks.deployment.mockResolvedValue({
    id: "source",
    workspaceId: "workspace",
    source: "config",
    sourceRef: null,
    status: "running",
    server: null,
    installCfg: credentials.sealMcpEnvironment(
      { command: "docker", args: ["run", image], env: {} },
      "workspace",
      oldSpec.containerEnv,
    ),
  });
  mocks.spawn.mockReset();
  mocks.update.mockResolvedValue({});
  mocks.workspace.mockResolvedValue({ id: "workspace" });
  mocks.materialize
    .mockReset()
    .mockResolvedValue({ hasFiles: false, redactionValues: [] });
  mocks.removeVolume.mockReset().mockResolvedValue(undefined);
  mocks.removeContainer.mockReset().mockResolvedValue(undefined);
  vi.spyOn(process, "kill").mockReturnValue(true);
  resetGlobals();
  rmSync(registryDir, { recursive: true, force: true });
});
afterEach(async () => {
  await supervisor.shutdownOwnedProcesses();
  resetGlobals();
  rmSync(registryDir, { recursive: true, force: true });
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => {
  if (originalRegistryDir === undefined)
    delete process.env.TOOLPLANE_SUPERVISOR_DIR;
  else process.env.TOOLPLANE_SUPERVISOR_DIR = originalRegistryDir;
});

describe("source-deployment session lifecycle", () => {
  it("stops every associated session, preserves another source, and lazily admits rotated/narrowed credentials", async () => {
    const first = childProcess();
    const second = childProcess();
    const other = childProcess();
    const replacement = childProcess();
    mocks.spawn
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValueOnce(other)
      .mockReturnValueOnce(replacement);
    await supervisor.startProcess("session-first", oldSpec, options);
    await supervisor.startProcess("session-second", oldSpec, options);
    await supervisor.startProcess("session-other", oldSpec, {
      ...options,
      configSourceDeploymentId: "other-source",
    });
    first.stdout.emit("data", Buffer.from("LISTENING 4101\n"));
    second.stdout.emit("data", Buffer.from("LISTENING 4102\n"));
    other.stdout.emit("data", Buffer.from("LISTENING 4103\n"));
    const oldIdentity =
      supervisor.liveMcpRuntimeSnapshot("session-first")?.credentialIdentity;
    mocks.removeContainer.mockClear();

    await expect(
      setDeploymentEnvAction(credentialForm()),
    ).resolves.toMatchObject({
      savedAt: expect.any(Number),
      requiresSetup: false,
    });
    expect(first.kill).toHaveBeenCalled();
    expect(second.kill).toHaveBeenCalled();
    expect(other.kill).not.toHaveBeenCalled();
    expect(supervisor.liveMcpRuntimeSnapshot("session-first")).toBeNull();
    expect(supervisor.liveMcpRuntimeSnapshot("session-second")).toBeNull();
    expect(supervisor.liveMcpRuntimeSnapshot("session-other")).not.toBeNull();
    expect(mocks.removeVolume.mock.calls.map((call) => call[0]).sort()).toEqual(
      ["session-first", "session-second"],
    );
    expect(
      mocks.removeContainer.mock.calls.map((call) => call[0]).sort(),
    ).toEqual(["session-first", "session-second"]);
    expect(
      mocks.update.mock.calls.every((call) => call[0].where.id === "source"),
    ).toBe(true);

    const mutation = mocks.update.mock.calls.find((call) =>
      Object.hasOwn(call[0].data, "installCfg"),
    );
    if (!mutation)
      throw new Error(
        "Credential mutation did not persist its encrypted result",
      );
    const environment = credentials.resolveMcpEnvironment(
      mutation[0].data.installCfg,
      "workspace",
    );
    expect(environment.TOKEN).toBe("rotated-token");
    expect(environment.OPTIONAL_TOKEN).not.toBe("optional-token");
    const narrowed = {
      ...oldSpec,
      containerEnv: Object.fromEntries(
        Object.entries(environment).filter(([, value]) => Boolean(value)),
      ),
    };
    await supervisor.startProcess("session-first", narrowed, options);
    replacement.stdout.emit("data", Buffer.from("LISTENING 4104\n"));
    expect(
      supervisor.liveMcpRuntimeSnapshot("session-first")?.credentialIdentity,
    ).toBe(supervisor.mcpRuntimeCredentialIdentity(narrowed));
    expect(
      supervisor.liveMcpRuntimeSnapshot("session-first")?.credentialIdentity,
    ).not.toBe(oldIdentity);
    expect(mocks.spawn).toHaveBeenCalledTimes(4);
  });

  it("drains an already queued sidecar launch before source stop completes", async () => {
    const entered = Promise.withResolvers<void>();
    const projection = Promise.withResolvers<{
      hasFiles: boolean;
      redactionValues: string[];
    }>();
    mocks.materialize.mockImplementationOnce(() => {
      entered.resolve();
      return projection.promise;
    });
    const child = childProcess();
    mocks.spawn.mockReturnValue(child);
    const starting = supervisor.startProcess(
      "session-queued",
      oldSpec,
      options,
    );
    await entered.promise;
    const stopping = supervisor.stopProcess("source");
    projection.resolve({ hasFiles: false, redactionValues: [] });
    await Promise.all([starting, stopping]);
    expect(child.kill).toHaveBeenCalled();
    expect(supervisor.liveMcpRuntimeSnapshot("session-queued")).toBeNull();
    expect(mocks.removeVolume).toHaveBeenCalledWith("session-queued");
  });

  it("propagates projection cleanup failure and retains the association for retry", async () => {
    const child = childProcess();
    mocks.spawn.mockReturnValue(child);
    await supervisor.startProcess("session-secret", oldSpec, options);
    mocks.removeVolume.mockRejectedValueOnce(new Error("projection busy"));
    await expect(supervisor.stopProcess("source")).rejects.toThrow(
      "projection busy",
    );
    expect(child.kill).toHaveBeenCalled();
    expectOnlyStoppedSourceWrites();
    await expect(supervisor.stopProcess("source")).resolves.toBeUndefined();
    expect(mocks.removeVolume).toHaveBeenCalledTimes(2);
  });

  it("does not report a stopped source when its sidecar container cannot be removed", async () => {
    const child = childProcess();
    mocks.spawn.mockReturnValue(child);
    await supervisor.startProcess("session-container", oldSpec, options);
    mocks.removeContainer.mockRejectedValueOnce(new Error("container busy"));
    await expect(supervisor.stopProcess("source")).rejects.toThrow(
      "container busy",
    );
    expect(mocks.removeVolume).not.toHaveBeenCalled();
    expectOnlyStoppedSourceWrites();
    await expect(supervisor.stopProcess("source")).resolves.toBeUndefined();
    expect(mocks.removeVolume).toHaveBeenCalledWith("session-container");
  });

  it("does not persist a credential rotation when source-sidecar cleanup fails", async () => {
    const child = childProcess();
    mocks.spawn.mockReturnValue(child);
    await supervisor.startProcess("session-credential", oldSpec, options);
    mocks.removeContainer.mockRejectedValueOnce(new Error("container busy"));
    await expect(setDeploymentEnvAction(credentialForm())).rejects.toThrow(
      "container busy",
    );
    expectOnlyStoppedSourceWrites();
  });

  it("prevents a deleted source from admitting another session after cascading kill", async () => {
    const child = childProcess();
    mocks.spawn.mockReturnValue(child);
    await supervisor.startProcess("session-deleted", oldSpec, options);
    await supervisor.killProcess("source", { preventRestart: true });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(mocks.removeVolume).toHaveBeenCalledWith("session-deleted");
    await expect(
      supervisor.startProcess("session-late", oldSpec, options),
    ).rejects.toThrow("MCP_SOURCE_UNAVAILABLE");
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });

  it("drains all source sidecars before surfacing one cleanup failure", async () => {
    mocks.spawn
      .mockReturnValueOnce(childProcess())
      .mockReturnValueOnce(childProcess());
    await supervisor.startProcess("session-failing", oldSpec, options);
    await supervisor.startProcess("session-draining", oldSpec, options);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = new Error("first cleanup failed");
    mocks.removeVolume.mockImplementation((id: string) => {
      if (id === "session-failing") return Promise.reject(failure);
      entered.resolve();
      return release.promise;
    });
    let settled = false;
    const stopped = supervisor.stopProcess("source").then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await entered.promise;
    expect(settled).toBe(false);
    release.resolve();
    await expect(stopped).resolves.toBe(failure);
    expectOnlyStoppedSourceWrites();
  });

  it("keeps a replacement indexed when it waits behind private projection cleanup", async () => {
    const first = childProcess();
    const replacement = childProcess();
    mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(replacement);
    await supervisor.startProcess("session-replacement", oldSpec, options);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    mocks.removeVolume.mockImplementationOnce(() => {
      entered.resolve();
      return release.promise;
    });
    const stopping = supervisor.stopProcess("session-replacement");
    await entered.promise;
    const starting = supervisor.startProcess(
      "session-replacement",
      { ...oldSpec, containerEnv: { TOKEN: "rotated-token" } },
      options,
    );
    expect(mocks.spawn).toHaveBeenCalledOnce();
    release.resolve();
    await Promise.all([stopping, starting]);
    await supervisor.stopProcess("source");
    expect(replacement.kill).toHaveBeenCalled();
    expect(mocks.removeVolume).toHaveBeenCalledTimes(2);
  });

  it("drains a disposable remote proxy without requiring Docker or a configuration projection", async () => {
    const child = childProcess();
    mocks.spawn.mockReturnValue(child);
    await supervisor.startProcess(
      "inspection-remote",
      {
        kind: "remote",
        name: "Remote inspection",
        url: "https://mcp.example.test/rpc",
        transport: "streamable-http",
        headers: { Authorization: "Bearer private-token" },
        timeoutMs: 5_000,
        allowUnsafeHttp: false,
      },
      options,
    );
    await supervisor.stopProcess("source");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(mocks.materialize).not.toHaveBeenCalled();
    expect(mocks.removeContainer).not.toHaveBeenCalled();
    expect(mocks.removeVolume).not.toHaveBeenCalled();
    expectOnlyStoppedSourceWrites();
  });
});
