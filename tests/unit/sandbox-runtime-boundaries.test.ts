// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import {
  copyDockerVolume,
  DockerVolumeCopyCleanupError,
  pullDockerImage,
  resolveDockerImageDigest,
  removeDockerVolume,
  removeDockerVolumeStrict,
  removeStaleDockerVolumeCopyHelpers,
  removeStaleHermesArchiveImportHelpers,
  stopDockerSandboxContainer,
} from "@/lib/sandboxes/runtime";

function childResult(stdout = "", stderr = "", code: number | null = 0) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(stdout));
    child.stderr.emit("data", Buffer.from(stderr));
    child.emit("exit", code, null);
  });
  return child;
}

beforeEach(() => {
  mocks.spawn.mockReset().mockImplementation(() => childResult());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Docker image pinning", () => {
  it.each(["", "--help", "image with spaces", "image;touch /tmp/x"])(
    "rejects an unsafe image reference %j before spawning",
    async (image) => {
      await expect(pullDockerImage(image)).rejects.toThrow(
        "Invalid Docker image",
      );
      await expect(resolveDockerImageDigest(image)).rejects.toThrow(
        "Invalid Docker image",
      );
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it("preserves already pinned digests without pulling", async () => {
    const digest = `registry.test:5000/org/image@sha256:${"a".repeat(64)}`;
    await expect(resolveDockerImageDigest(digest)).resolves.toBe(digest);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("selects the matching repository rather than another valid digest", async () => {
    const expected = `registry.test:5000/org/image@sha256:${"a".repeat(64)}`;
    mocks.spawn
      .mockImplementationOnce(() => childResult())
      .mockImplementationOnce(() =>
        childResult(
          JSON.stringify([
            null,
            42,
            `other@sha256:${"b".repeat(64)}`,
            expected,
          ]),
        ),
      );
    await expect(
      resolveDockerImageDigest("registry.test:5000/org/image:latest"),
    ).resolves.toBe(expected);
  });

  it("falls back to an available registry digest for aliases", async () => {
    const digest = `docker.io/library/alpine@sha256:${"c".repeat(64)}`;
    mocks.spawn
      .mockImplementationOnce(() => childResult())
      .mockImplementationOnce(() => childResult(JSON.stringify([digest])));
    await expect(resolveDockerImageDigest("alpine")).resolves.toBe(digest);
  });

  it.each([
    ["not json", "valid image digest"],
    ["null", "no immutable registry digest"],
    ["[]", "no immutable registry digest"],
    [JSON.stringify(["invalid@sha256:abc", 1]), "no immutable registry digest"],
    [
      JSON.stringify([`${"x".repeat(260)}@sha256:${"a".repeat(64)}`]),
      "no immutable registry digest",
    ],
  ])("rejects unusable digest output %s", async (output, message) => {
    mocks.spawn
      .mockImplementationOnce(() => childResult())
      .mockImplementationOnce(() => childResult(output));
    await expect(resolveDockerImageDigest("alpine:latest")).rejects.toThrow(
      message,
    );
  });

  it("does not pass application secrets to Docker", async () => {
    vi.stubEnv("DATABASE_URL", "private-database");
    vi.stubEnv("DOCKER_HOST", "unix:///tmp/docker.sock");
    await pullDockerImage("alpine:latest");
    expect(mocks.spawn.mock.calls[0][2].env).toMatchObject({
      DOCKER_HOST: "unix:///tmp/docker.sock",
    });
    expect(mocks.spawn.mock.calls[0][2].env).not.toHaveProperty("DATABASE_URL");
  });

  it("kills stalled commands and rejects once even if exit arrives later", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    mocks.spawn.mockReturnValue(child);
    const result = expect(pullDockerImage("alpine", 50)).rejects.toThrow(
      "timed out after 50ms",
    );
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("exit", 0, null);
  });

  it("propagates spawn errors and bounds daemon error output", async () => {
    mocks.spawn.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => child.emit("error", new Error("spawn unavailable")));
      return child;
    });
    await expect(pullDockerImage("alpine")).rejects.toThrow(
      "spawn unavailable",
    );
    mocks.spawn.mockImplementationOnce(() =>
      childResult("", "x".repeat(70_000), 1),
    );
    await expect(pullDockerImage("alpine")).rejects.toHaveProperty(
      "message",
      "x".repeat(65_536),
    );
  });
});

describe("Docker cleanup boundaries", () => {
  it("skips invalid best-effort names but rejects invalid strict names", async () => {
    await removeDockerVolume("../bad");
    await expect(removeDockerVolumeStrict("../bad")).rejects.toThrow(
      "Invalid Docker volume name",
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("ignores missing containers and volumes but preserves other daemon failures", async () => {
    mocks.spawn.mockImplementationOnce(() =>
      childResult("", "No such container: gone", 1),
    );
    await expect(stopDockerSandboxContainer("gone")).resolves.toBeUndefined();
    mocks.spawn.mockImplementationOnce(() =>
      childResult("", "No such volume: gone", 1),
    );
    await expect(removeDockerVolumeStrict("gone")).resolves.toBeUndefined();
    mocks.spawn.mockImplementationOnce(() =>
      childResult("", "volume is in use", 1),
    );
    await expect(removeDockerVolumeStrict("busy")).rejects.toThrow(
      "volume is in use",
    );
    mocks.spawn.mockImplementationOnce(() =>
      childResult("", "daemon unavailable", 1),
    );
    await expect(removeDockerVolume("busy")).resolves.toBeUndefined();
  });

  it("removes only old helpers and tolerates inspection races", async () => {
    mocks.spawn
      .mockImplementationOnce(() => childResult("old recent gone\n"))
      .mockImplementationOnce(() => childResult("2025-01-01T00:00:00Z"))
      .mockImplementationOnce(() => childResult("", "No such container", 1))
      .mockImplementationOnce(() => childResult("2026-01-01T00:00:00Z"))
      .mockImplementationOnce(() => childResult("", "No such object", 1));
    await expect(
      removeStaleDockerVolumeCopyHelpers(new Date("2026-01-01T00:00:00Z")),
    ).resolves.toBe(1);
    expect(
      mocks.spawn.mock.calls
        .filter(([, args]) => args[0] === "rm")
        .map(([, args]) => args),
    ).toEqual([["rm", "-f", "old"]]);
  });

  it.each(["invalid timestamp", "daemon permission denied"])(
    "fails closed on helper inspection error %s",
    async (failure) => {
      mocks.spawn
        .mockImplementationOnce(() => childResult("helper"))
        .mockImplementationOnce(() =>
          failure === "invalid timestamp"
            ? childResult(failure)
            : childResult("", failure, 1),
        );
      await expect(
        removeStaleHermesArchiveImportHelpers(new Date()),
      ).rejects.toThrow(
        failure === "invalid timestamp" ? "invalid creation time" : failure,
      );
      expect(mocks.spawn.mock.calls.some(([, args]) => args[0] === "rm")).toBe(
        false,
      );
    },
  );

  it.each([false, true])(
    "reports cleanup failure with copy failure=%s",
    async (copyFails) => {
      mocks.spawn
        .mockImplementationOnce(() => childResult())
        .mockImplementationOnce(() => childResult())
        .mockImplementationOnce(() =>
          childResult("", copyFails ? "copy failed" : "", copyFails ? 1 : 0),
        )
        .mockImplementationOnce(() => childResult("", "cleanup failed", 1));
      const error = await copyDockerVolume("source", "destination").catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(DockerVolumeCopyCleanupError);
      expect(error).toMatchObject({
        errors: copyFails
          ? [
              expect.objectContaining({ message: "copy failed" }),
              expect.objectContaining({ message: "cleanup failed" }),
            ]
          : [expect.objectContaining({ message: "cleanup failed" })],
        helperName: expect.stringMatching(/^toolplane-volume-copy-/),
      });
    },
  );

  it("returns the copy error when cleanup succeeds", async () => {
    mocks.spawn
      .mockImplementationOnce(() => childResult())
      .mockImplementationOnce(() => childResult())
      .mockImplementationOnce(() => childResult("", "copy failed", 1));
    await expect(copyDockerVolume("source", "destination")).rejects.toThrow(
      "copy failed",
    );
    expect(mocks.spawn.mock.calls.at(-1)?.[1]).toEqual([
      "rm",
      "-f",
      expect.stringMatching(/^toolplane-volume-copy-/),
    ]);
  });
});
