// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  trackRuntimeOperation: vi.fn(),
  runtimeAbortSignal: vi.fn(),
  markRuntimeUncertain: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
  default: { spawn: mocks.spawn },
}));
vi.mock("@/lib/runtime/ownership-state", () => ({
  trackRuntimeOperation: mocks.trackRuntimeOperation,
  runtimeAbortSignal: mocks.runtimeAbortSignal,
  markRuntimeUncertain: mocks.markRuntimeUncertain,
}));
vi.mock("@/lib/sandboxes/runtime", () => ({
  sandboxVolumeName: (id: string) => `volume-${id}`,
  sandboxSyncContainerName: (id: string) => `archive-${id}`,
}));

import { copyHermesArchiveToVolume } from "@/lib/agents/hermes/archive-storage";

class StorageChild extends EventEmitter {
  stderr = new PassThrough();
  kill = vi.fn();
}

const archive = {
  directory: "/tmp/staged-home",
  image: "archive-image:test",
  sandboxId: "history",
};

describe("offline historical archive storage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.trackRuntimeOperation.mockImplementation((operation) => operation());
    mocks.spawn.mockImplementation(() => {
      const child = new StorageChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("copies through an isolated bounded helper without launching Hermes or forwarding credentials", async () => {
    vi.stubEnv("DOCKER_HOST", "unix:///tmp/docker-fixture.sock");
    vi.stubEnv("ANTHROPIC_API_KEY", "must-not-leak");
    await copyHermesArchiveToVolume(archive);
    const commands = mocks.spawn.mock.calls.map((call) => call[1] as string[]);
    expect(commands.map((args) => args[0])).toEqual([
      "volume",
      "rm",
      "create",
      "cp",
      "start",
      "rm",
    ]);
    expect(commands[0]).toEqual(["volume", "create", "volume-history"]);
    expect(commands[2]).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "1g",
        "--pids-limit",
        "256",
        "--entrypoint",
        "/bin/sh",
      ]),
    );
    expect(commands[2].at(-1)).toContain(
      "cp -R /tmp/toolplane-import/. /opt/data/",
    );
    expect(commands[3]).toEqual([
      "cp",
      "/tmp/staged-home/.",
      "archive-history:/tmp/toolplane-import",
    ]);
    expect(commands.at(-1)).toEqual(["rm", "-f", "archive-history"]);
    for (const call of mocks.spawn.mock.calls) {
      expect(call[0]).toBe("docker");
      expect(call[2].env.DOCKER_HOST).toBe("unix:///tmp/docker-fixture.sock");
      expect(call[2].env.ANTHROPIC_API_KEY).toBeUndefined();
    }
    expect(mocks.trackRuntimeOperation).toHaveBeenCalledTimes(commands.length);
  });

  it("surfaces copy failure and removes only the helper, retaining the historical volume", async () => {
    mocks.spawn.mockImplementation((_command: string, args: string[]) => {
      const child = new StorageChild();
      queueMicrotask(() => {
        if (args[0] === "cp") {
          child.stderr.write("archive copy failed");
          child.emit("close", 1);
        } else child.emit("close", 0);
      });
      return child;
    });
    await expect(copyHermesArchiveToVolume(archive)).rejects.toThrow(
      "archive copy failed",
    );
    const commands = mocks.spawn.mock.calls.map((call) => call[1] as string[]);
    expect(commands.at(-1)).toEqual(["rm", "-f", "archive-history"]);
    expect(
      commands.some((args) => args[0] === "volume" && args[1] === "rm"),
    ).toBe(false);
    expect(commands.some((args) => args[0] === "start")).toBe(false);
  });
});
