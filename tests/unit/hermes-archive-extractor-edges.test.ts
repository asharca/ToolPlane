// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { stageHermesArchiveStream } from "@/lib/agents/hermes/archive";
let root: string;
function upload(size?: number) {
  return {
    name: "home.zip",
    size,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    }),
  };
}
function childResult(output: string, code: number | null = 0, error = false) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(output));
    if (error) child.emit("error", new Error("spawn failed"));
    child.emit("close", code);
  });
  return child;
}
describe("Hermes archive extractor boundary validation", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    root = await mkdtemp(path.join(os.tmpdir(), "hermes-extractor-test-"));
    vi.stubEnv("TOOLPLANE_HERMES_ARCHIVE_TMP_DIR", root);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
  ])("rejects invalid declared size %s before staging", async (size) => {
    await expect(stageHermesArchiveStream(upload(size))).rejects.toMatchObject({
      statusCode: 413,
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
  it.each([
    [{ files: 0, bytes: 0 }],
    [{ files: 1.5, bytes: 0 }],
    [{ files: 200001, bytes: 0 }],
    [{ files: "invalid", bytes: 0 }],
    [{ files: 1, bytes: -1 }],
    [{ files: 1, bytes: "invalid" }],
    [{ files: 1, bytes: 1e20 }],
    [{}],
  ])(
    "rejects malformed extractor accounting %j and removes its upload",
    async (value) => {
      mocks.spawn.mockImplementation(() => childResult(JSON.stringify(value)));
      await expect(stageHermesArchiveStream(upload())).rejects.toMatchObject({
        name: "HermesArchiveError",
        statusCode: 400,
      });
      expect(await readdir(root)).toEqual([]);
    },
  );
  it.each([
    ["archive file count is invalid", "too many ZIP entries"],
    ["archive compression ratio exceeds limit", "expands too much"],
    ["archive symlink target is too large", "invalid target"],
    ["archive symlink target is invalid", "invalid target"],
    ["archive symlink escapes Hermes home", "escapes the Hermes home"],
    ["unsafe archive symlink", "invalid target"],
    ["archive contains too many symbolic links", "too many symbolic links"],
    [
      "Hermes configuration files cannot be symbolic links",
      "must be regular files",
    ],
    [".hermes folder not found", "must contain a .hermes folder"],
    ["archive contains files outside .hermes", "outside the selected"],
    ["archive contains multiple Hermes homes", "more than one .hermes folder"],
    ["not enough staging inodes", "temporary filesystem entries"],
  ])(
    "maps extractor failure %s to a safe user explanation",
    async (error, expected) => {
      mocks.spawn.mockImplementation(() =>
        childResult(JSON.stringify({ error }), 1),
      );
      await expect(stageHermesArchiveStream(upload())).rejects.toThrow(
        expected,
      );
      expect(await readdir(root)).toEqual([]);
    },
  );
  it.each([
    "not json",
    JSON.stringify({ error: 3 }),
    JSON.stringify({ error: "private /host/path" }),
    "x".repeat(9000),
  ])("hides unrecognized extractor output", async (output) => {
    mocks.spawn.mockImplementation(() => childResult(output, 1));
    await expect(stageHermesArchiveStream(upload())).rejects.toThrow(
      "Upload a trusted ZIP",
    );
    expect(await readdir(root)).toEqual([]);
  });
  it("reports spawn failure only once even when the child also closes", async () => {
    mocks.spawn.mockImplementation(() => childResult("", null, true));
    await expect(stageHermesArchiveStream(upload())).rejects.toThrow(
      "Could not inspect the archive on this server.",
    );
    expect(await readdir(root)).toEqual([]);
  });
  it("accepts valid numeric accounting and exposes idempotent cleanup", async () => {
    vi.stubEnv("TOOLPLANE_PYTHON", " /custom/python ");
    mocks.spawn.mockImplementation(() =>
      childResult('{"files":"1","bytes":"0"}'),
    );
    const staged = await stageHermesArchiveStream(upload(), {
      maxUploadMiB: 1,
      stagingToken: "reservation-token",
    });
    expect(staged).toMatchObject({ fileCount: 1, unpackedBytes: 0 });
    expect(staged.directory).toContain(
      "toolplane-hermes-import-reservation-token-",
    );
    expect(mocks.spawn.mock.calls[0][0]).toBe("/custom/python");
    await staged.cleanup();
    await staged.cleanup();
    expect(await readdir(root)).toEqual([]);
  });
  it.each(["ENOSPC", "EIO"])(
    "maps upload stream failure %s and cleans staging",
    async (code) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(Object.assign(new Error("private error"), { code }));
        },
      });
      await expect(
        stageHermesArchiveStream({ name: "home.zip", body }),
      ).rejects.toMatchObject({ statusCode: code === "ENOSPC" ? 507 : 400 });
      expect(await readdir(root)).toEqual([]);
    },
  );
});
