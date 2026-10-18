import { assertDefined } from "../assert-defined";
// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import {
  AttachmentStorageError,
  EmptyAttachmentError,
  safeAttachmentFilename,
  readWorkspaceAttachment,
  deleteWorkspaceAttachmentFile,
  removeWorkspaceAttachmentVolume,
  copyWorkspaceAttachmentToDockerVolume,
  AttachmentTooLargeError,
  workspaceAttachmentVolumeName,
  writeWorkspaceAttachment,
} from "@/lib/attachments/storage";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  private closed = false;

  finish(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("close", code, signal));
  }

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.killed = true;
    this.finish(null, signal);
    return true;
  }
}

function body(value: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

const validPath = "objects/12345678-1234-1234-1234-123456789abc-notes.txt";

describe("workspace attachment Docker storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spawn.mockImplementation((_command: string, args: string[]) => {
      const child = new FakeChild();
      if (args.includes("-i")) child.stdin.once("finish", () => child.finish());
      else queueMicrotask(() => child.finish());
      return child;
    });
  });

  afterEach(() => vi.useRealTimers());

  it("terminates commands which never finish", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValueOnce(child);
    const result = removeWorkspaceAttachmentVolume("workspace_1");
    const assertion = expect(result).rejects.toThrow(
      "Docker command timed out after 30000ms.",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(child.killed).toBe(true);
  });

  it("wraps Docker process errors as storage errors", async () => {
    mocks.spawn.mockImplementationOnce(() => {
      const child = new FakeChild();
      queueMicrotask(() => child.emit("error", new Error("docker missing")));
      return child;
    });
    await expect(
      removeWorkspaceAttachmentVolume("workspace_1"),
    ).rejects.toBeInstanceOf(AttachmentStorageError);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid byte limits %s before spawning",
    async (maxBytes) => {
      await expect(
        writeWorkspaceAttachment({
          workspaceId: "workspace_1",
          filename: "x",
          body: body("x"),
          maxBytes,
        }),
      ).rejects.toThrow("Invalid attachment byte limit.");
      expect(() =>
        readWorkspaceAttachment("workspace_1", "invalid", maxBytes),
      ).toThrow("Invalid attachment byte limit.");
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it("normalizes cross-platform filenames and bounds their length", () => {
    expect(safeAttachmentFilename("C:\\folder\\Ｆｉｌｅ name.txt")).toBe(
      "File-name.txt",
    );
    expect(safeAttachmentFilename("/folder/💥")).toBe("attachment");
    expect(safeAttachmentFilename("/folder/")).toBe("attachment");
    expect(safeAttachmentFilename("a".repeat(130))).toHaveLength(120);
  });

  it("cleans temporary uploads when their body is empty", async () => {
    await expect(
      writeWorkspaceAttachment({
        workspaceId: "workspace_1",
        filename: "empty",
        body: body(""),
        maxBytes: 10,
      }),
    ).rejects.toBeInstanceOf(EmptyAttachmentError);
    const scripts = mocks.spawn.mock.calls.flatMap(
      (call) => call[1] as string[],
    );
    expect(scripts).toContain('rm -f "$1"');
    expect(scripts.some((script) => script.includes("wc -c"))).toBe(false);
  });

  it("rejects an already-aborted upload and removes its temporary file", async () => {
    await expect(
      writeWorkspaceAttachment({
        workspaceId: "workspace_1",
        filename: "x",
        body: body("x"),
        maxBytes: 10,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow("Attachment upload was aborted.");
    expect(
      mocks.spawn.mock.calls.some((call) =>
        (call[1] as string[]).includes("-i"),
      ),
    ).toBe(false);
    expect(
      mocks.spawn.mock.calls.flatMap((call) => call[1] as string[]),
    ).toContain('rm -f "$1"');
  });

  it("returns downloaded bytes from a read-only attachment volume", async () => {
    mocks.spawn.mockImplementationOnce(() => {
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.write("download");
        child.finish();
      });
      return child;
    });
    const response = new Response(
      readWorkspaceAttachment("workspace_1", validPath, 8),
    );
    await expect(response.text()).resolves.toBe("download");
    expect(mocks.spawn.mock.calls[0][1]).toContain(
      "type=volume,src=toolplane_attachment_workspace_1,dst=/attachments,readonly",
    );
  });

  it("kills a download helper when the stored object exceeds its declared limit", async () => {
    const child = new FakeChild();
    mocks.spawn.mockImplementationOnce(() => {
      queueMicrotask(() => child.stdout.write("too large"));
      return child;
    });
    await expect(
      new Response(readWorkspaceAttachment("workspace_1", validPath, 3)).text(),
    ).rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(child.killed).toBe(true);
  });

  it.each([
    ["missing object", 1, null, "missing object"],
    ["", null, "SIGTERM", "SIGTERM"],
    ["", null, null, "unknown"],
  ] as const)(
    "reports helper failures during reads: %s",
    async (stderr, code, signal, message) => {
      mocks.spawn.mockImplementationOnce(() => {
        const child = new FakeChild();
        queueMicrotask(() => {
          child.stderr.write(stderr);
          child.finish(code, signal);
        });
        return child;
      });
      await expect(
        new Response(
          readWorkspaceAttachment("workspace_1", validPath, 10),
        ).text(),
      ).rejects.toThrow(message);
    },
  );

  it("surfaces process start errors without exposing an indefinite read", async () => {
    mocks.spawn.mockImplementationOnce(() => {
      const child = new FakeChild();
      queueMicrotask(() => child.emit("error", new Error("spawn denied")));
      return child;
    });
    await expect(
      new Response(
        readWorkspaceAttachment("workspace_1", validPath, 10),
      ).text(),
    ).rejects.toThrow("spawn denied");
  });

  it.each(["../x", "objects/not-a-uuid-x", `${validPath}/extra`])(
    "rejects unsafe storage paths before invoking Docker: %s",
    async (storagePath) => {
      expect(() =>
        readWorkspaceAttachment("workspace_1", storagePath, 10),
      ).toThrow("Invalid attachment storage path.");
      await expect(
        deleteWorkspaceAttachmentFile("workspace_1", storagePath),
      ).rejects.toThrow("Invalid attachment storage path.");
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it("deletes an existing attachment and tolerates absent volumes during cleanup", async () => {
    await deleteWorkspaceAttachmentFile("workspace_1", validPath);
    expect(mocks.spawn.mock.calls).toHaveLength(2);
    for (const operation of [
      () => deleteWorkspaceAttachmentFile("workspace_1", validPath),
      () => removeWorkspaceAttachmentVolume("workspace_1"),
    ]) {
      mocks.spawn.mockImplementationOnce(() => {
        const child = new FakeChild();
        queueMicrotask(() => {
          child.stderr.write("Error: no such volume");
          child.finish(1);
        });
        return child;
      });
      await expect(operation()).resolves.toBeUndefined();
    }
  });

  it.each(["delete", "remove"])(
    "does not suppress Docker permission errors during %s",
    async (operation) => {
      mocks.spawn.mockImplementationOnce(() => {
        const child = new FakeChild();
        queueMicrotask(() => {
          child.stderr.write("permission denied");
          child.finish(1);
        });
        return child;
      });
      await expect(
        operation === "delete"
          ? deleteWorkspaceAttachmentFile("workspace_1", validPath)
          : removeWorkspaceAttachmentVolume("workspace_1"),
      ).rejects.toThrow("permission denied");
    },
  );

  it.each([
    "/absolute",
    "folder/../secret",
    "",
    "space name",
    "a".repeat(1001),
  ])("rejects unsafe copy destinations: %s", async (destinationPath) => {
    await expect(
      copyWorkspaceAttachmentToDockerVolume({
        workspaceId: "workspace_1",
        storagePath: validPath,
        destinationVolume: "sandbox_test",
        destinationPath,
      }),
    ).rejects.toThrow("Invalid sandbox attachment path.");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("validates copy source and volume names before copying", async () => {
    await expect(
      copyWorkspaceAttachmentToDockerVolume({
        workspaceId: "workspace_1",
        storagePath: validPath,
        destinationVolume: "../escape",
        destinationPath: "files/x",
      }),
    ).rejects.toThrow("Invalid sandbox volume name.");
    await expect(
      copyWorkspaceAttachmentToDockerVolume({
        workspaceId: "workspace_1",
        storagePath: "../escape",
        destinationVolume: "sandbox_test",
        destinationPath: "files/x",
      }),
    ).rejects.toThrow("Invalid attachment storage path.");
    expect(mocks.spawn).not.toHaveBeenCalled();
    await copyWorkspaceAttachmentToDockerVolume({
      workspaceId: "workspace_1",
      storagePath: validPath,
      destinationVolume: "sandbox_test",
      destinationPath: "files/x",
    });
    expect(mocks.spawn.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        "type=volume,src=toolplane_attachment_workspace_1,dst=/from,readonly",
        "type=volume,src=sandbox_test,dst=/to",
        `/from/${validPath}`,
        "/to/files/x",
      ]),
    );
  });

  it("derives a dedicated Docker-safe volume and streams through a restricted helper", async () => {
    const result = await writeWorkspaceAttachment({
      workspaceId: "workspace_1",
      filename: "../../notes with spaces.txt",
      body: body("hello"),
      maxBytes: 10,
    });

    expect(workspaceAttachmentVolumeName("workspace_1")).toBe(
      "toolplane_attachment_workspace_1",
    );
    expect(result.size).toBe(5);
    expect(result.storagePath).toMatch(
      /^objects\/[0-9a-f-]+-notes-with-spaces\.txt$/,
    );
    const uploadArgs = assertDefined(
      mocks.spawn.mock.calls
        .map((call) => call[1] as string[])
        .find((args) => args.includes("-i")),
    );
    expect(uploadArgs).toEqual(
      expect.arrayContaining([
        "run",
        "--rm",
        "-i",
        "--network",
        "none",
        "--read-only",
        "--memory",
        "128m",
        "--cpus",
        "0.25",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
      ]),
    );
    expect(uploadArgs.join(" ")).toContain(
      "type=volume,src=toolplane_attachment_workspace_1,dst=/attachments",
    );
  });

  it("stops a streamed upload at the server limit before finalizing it", async () => {
    await expect(
      writeWorkspaceAttachment({
        workspaceId: "workspace_1",
        filename: "notes.txt",
        body: body("too large"),
        maxBytes: 4,
      }),
    ).rejects.toBeInstanceOf(AttachmentTooLargeError);

    const scripts = mocks.spawn.mock.calls.flatMap(
      (call) => call[1] as string[],
    );
    expect(scripts.some((value) => value.includes("wc -c"))).toBe(false);
  });

  it("rejects workspace ids that cannot safely become Docker volume names", () => {
    expect(() => workspaceAttachmentVolumeName("../workspace")).toThrow(
      "Invalid workspace id.",
    );
  });
});
