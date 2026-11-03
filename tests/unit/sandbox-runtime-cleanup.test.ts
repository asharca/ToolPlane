// @vitest-environment node
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  failContainer: null as string | null,
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import {
  removeDockerSandboxRuntimeStrict,
  sandboxContainerName,
  sandboxSyncContainerName,
} from "@/lib/sandboxes/runtime";

describe("strict Docker sandbox cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.failContainer = null;
    mocks.spawn.mockImplementation((_command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        const failed =
          mocks.failContainer !== null && args.includes(mocks.failContainer);
        if (failed) child.stderr.emit("data", Buffer.from("cleanup denied"));
        child.emit("exit", failed ? 1 : 0, null);
      });
      return child;
    });
  });

  it("removes all volume consumers before deleting the volume", async () => {
    await removeDockerSandboxRuntimeStrict("sandbox-1", "volume-1");

    const operations = mocks.spawn.mock.calls.map(
      ([, args]) => args as string[],
    );
    const volumeRemoval = operations.findIndex((args) =>
      args.includes("volume-1"),
    );
    expect(volumeRemoval).toBeGreaterThan(-1);
    for (const container of [
      sandboxContainerName("sandbox-1"),
      sandboxSyncContainerName("sandbox-1"),
    ]) {
      const containerRemoval = operations.findIndex((args) =>
        args.includes(container),
      );
      expect(containerRemoval).toBeGreaterThan(-1);
      expect(containerRemoval).toBeLessThan(volumeRemoval);
    }
  });

  it.each([
    sandboxContainerName("sandbox-1"),
    sandboxSyncContainerName("sandbox-1"),
  ])(
    "preserves the volume if consumer cleanup fails for %s",
    async (container) => {
      mocks.failContainer = container;
      await expect(
        removeDockerSandboxRuntimeStrict("sandbox-1", "volume-1"),
      ).rejects.toThrow("cleanup denied");
      expect(
        mocks.spawn.mock.calls.some(([, args]) =>
          (args as string[]).includes("volume-1"),
        ),
      ).toBe(false);
    },
  );
});
