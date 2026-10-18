// @vitest-environment node
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), pty: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node-pty", () => ({ default: { spawn: mocks.pty } }));
import {
  createRuntime,
  parseArgs,
  validateAndroidSelector,
  parseVncEndpoint,
} from "../../packages/connector/bin/runtime.mjs";
type Reply = {
  output?: string;
  stderr?: string;
  error?: Error & { code?: string };
  code?: number;
  hang?: boolean;
};
const replies: Reply[] = [];
class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  pid = 999999999;
  closed = false;
  kill = vi.fn(() => {
    this.finish(null);
    return true;
  });
  finish(code: number | null) {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.emit("close", code, null);
  }
}
let root: string;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
beforeEach(async () => {
  vi.resetAllMocks();
  replies.length = 0;
  root = await mkdtemp(path.join(tmpdir(), "connector-boundaries-"));
  mocks.spawn.mockImplementation(() => {
    const child = new Child();
    const reply = replies.shift() ?? {};
    child.stdin.resume();
    queueMicrotask(() => {
      if (reply.hang) return;
      if (reply.output) child.stdout.write(reply.output);
      if (reply.stderr) child.stderr.write(reply.stderr);
      if (reply.error) child.emit("error", reply.error);
      child.finish(reply.code ?? 0);
    });
    return child;
  });
});
afterEach(async () => {
  if (originalPlatform)
    Object.defineProperty(process, "platform", originalPlatform);
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("connector desktop process boundaries", () => {
  it.each([undefined, "", "unsupported"])(
    "rejects missing or unknown runtime %s",
    async (runtime) => {
      await expect(
        createRuntime(root).handle(null, "process_exec", { runtime }),
      ).rejects.toThrow("runtime must be");
    },
  );
  it.each([
    "not-array",
    [5],
    ["nul\0"],
    ["a".repeat(8193)],
    Array(129).fill("x"),
    Array(4).fill("a".repeat(8000)),
  ])("rejects unbounded process argv %j", async (...row) => {
    const args = row.length === 1 && typeof row[0] === "string" ? row[0] : row;
    await expect(
      createRuntime(root).handle(null, "process_exec", {
        runtime: "node",
        args,
      }),
    ).rejects.toThrow("bounded strings");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each(["ENOENT", "EACCES", "ENOTDIR"])(
    "tries the next interpreter after %s",
    async (code) => {
      vi.stubEnv("PATH", root);
      replies.push(
        { error: Object.assign(new Error("unavailable"), { code }) },
        { output: "fallback" },
      );
      const result = await createRuntime(root).handle(null, "process_exec", {
        runtime: "python",
      });
      expect(result).toMatchObject({
        stdout: "fallback",
        executable: path.join(root, "python"),
      });
      expect(mocks.spawn).toHaveBeenCalledTimes(2);
    },
  );
  it("reports all missing runtimes and respects configured absolute and relative interpreter names", async () => {
    vi.stubEnv("PATH", "");
    await expect(
      createRuntime(root).handle(null, "process_exec", { runtime: "python" }),
    ).resolves.toMatchObject({
      executable: null,
      errorCode: "RUNTIME_UNAVAILABLE",
    });
    vi.stubEnv("TOOLPLANE_CONNECTOR_PYTHON", "/custom/python");
    await expect(
      createRuntime(root).handle(null, "process_exec", {
        runtime: "python",
        args: [],
      }),
    ).resolves.toMatchObject({ executable: "/custom/python" });
    vi.stubEnv("PATH", `"${root}"`);
    vi.stubEnv("TOOLPLANE_CONNECTOR_PYTHON", "my-python");
    await expect(
      createRuntime(root).handle(null, "process_exec", { runtime: "python" }),
    ).resolves.toMatchObject({ executable: path.join(root, "my-python") });
    vi.stubEnv("TOOLPLANE_CONNECTOR_BASH", "/custom/bash");
    await expect(
      createRuntime(root).handle(null, "process_exec", { runtime: "bash" }),
    ).resolves.toMatchObject({ executable: "/custom/bash" });
  });
  it("uses Windows Python launcher prefixes and requires explicit Bash on Windows", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    vi.stubEnv("PATH", root);
    vi.stubEnv("TOOLPLANE_CONNECTOR_BASH", "");
    await expect(
      createRuntime(root).handle(null, "process_exec", { runtime: "bash" }),
    ).resolves.toMatchObject({ errorCode: "RUNTIME_UNAVAILABLE" });
    await expect(
      createRuntime(root).handle(null, "process_exec", {
        runtime: "python",
        args: ["-c", "print(1)"],
      }),
    ).resolves.toMatchObject({ executable: path.join(root, "py.exe") });
    expect(mocks.spawn.mock.calls[0][1]).toEqual(["-3", "-c", "print(1)"]);
    vi.stubEnv("TOOLPLANE_CONNECTOR_PYTHON", "python.exe");
    await createRuntime(root).handle(null, "process_exec", {
      runtime: "python",
    });
    expect(mocks.spawn.mock.calls[1][1]).toEqual([]);
  });
  it("bounds stdout/stderr and reports launch errors without a string error code", async () => {
    replies.push({ output: "o".repeat(128001), stderr: "e".repeat(128001) });
    const result = await createRuntime(root).handle(null, "shell_exec", {
      command: "echo output",
      env: { VALID: "yes", "bad-key": "no", NUMBER: 1 },
    });
    if (!("stdout" in result) || !("stderr" in result))
      throw new Error("Expected process output");
    expect(result.stdout).toBe(`${"o".repeat(128000)}\n[output truncated]`);
    expect(result.stderr).toBe(`${"e".repeat(128000)}\n[output truncated]`);
    expect(mocks.spawn.mock.calls[0][2].env).toMatchObject({ VALID: "yes" });
    expect(mocks.spawn.mock.calls[0][2].env).not.toHaveProperty("bad-key");
    replies.push({ error: new Error("cannot spawn") });
    await expect(
      createRuntime(root).handle(null, "shell_exec", {
        command: "command",
        env: [],
      }),
    ).resolves.toMatchObject({ stderr: "cannot spawn", errorCode: null });
    await expect(
      createRuntime(root).handle(null, "shell_exec", {}),
    ).rejects.toThrow("command is required");
  });
});

describe("connector desktop terminal sessions", () => {
  it("rejects files as terminal working directories and unknown terminal ids", async () => {
    await writeFile(path.join(root, "file"), "data");
    const runtime = createRuntime(root);
    await expect(
      runtime.handle(null, "terminal_create", { cwd: "file" }),
    ).rejects.toThrow("not a directory");
    await expect(runtime.handle(null, "terminal_input", {})).rejects.toThrow(
      "terminal session not found",
    );
    await expect(runtime.handle(null, "terminal_resize", {})).rejects.toThrow(
      "terminal session not found",
    );
    await expect(runtime.handle(null, "terminal_close", {})).resolves.toEqual({
      ok: true,
    });
    await expect(runtime.handle(null, "unsupported", {})).rejects.toThrow(
      "Unknown connector op",
    );
  });
  it("clamps terminal dimensions and closes sessions independently of socket readiness", async () => {
    let onData: (data: string) => void = () => undefined;
    let onExit: (event: { exitCode: number; signal: number }) => void = () =>
      undefined;
    const terminal = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn((callback) => {
        onData = callback;
      }),
      onExit: vi.fn((callback) => {
        onExit = callback;
      }),
    };
    mocks.pty.mockReturnValue(terminal);
    vi.stubEnv("LANG", "");
    vi.stubEnv("LC_ALL", "");
    const runtime = createRuntime(root);
    const ws = { readyState: 1, send: vi.fn() };
    const first = await runtime.handle(ws, "terminal_create", {
      cols: 1,
      rows: 999,
      env: [],
    });
    if (!("terminalId" in first)) throw new Error("Expected terminal session");
    expect(mocks.pty.mock.calls[0][2]).toMatchObject({
      cols: 20,
      rows: 80,
      env: expect.objectContaining({ LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }),
    });
    onData("visible");
    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
      type: "terminal_data",
      data: "visible",
    });
    ws.readyState = 3;
    onData("hidden");
    expect(ws.send).toHaveBeenCalledOnce();
    await runtime.handle(ws, "terminal_input", {
      terminalId: first.terminalId,
    });
    expect(terminal.write).toHaveBeenCalledWith("");
    await runtime.handle(ws, "terminal_resize", {
      terminalId: first.terminalId,
    });
    expect(terminal.resize).toHaveBeenCalledWith(80, 24);
    await runtime.handle(ws, "terminal_resize", {
      terminalId: first.terminalId,
      cols: 999,
      rows: 1,
    });
    expect(terminal.resize).toHaveBeenLastCalledWith(240, 6);
    onExit({ exitCode: 1, signal: 9 });
    expect(ws.send).toHaveBeenCalledOnce();
    await expect(
      runtime.handle(ws, "terminal_input", { terminalId: first.terminalId }),
    ).rejects.toThrow("terminal session not found");
    const second = await runtime.handle(ws, "terminal_create", {});
    await runtime.handle(ws, "terminal_close", second);
    await runtime.handle(ws, "terminal_close", second);
    expect(terminal.kill).toHaveBeenCalledOnce();
    await runtime.handle(ws, "terminal_create", {});
    runtime.closeAllTerminals();
    expect(terminal.kill).toHaveBeenCalledTimes(2);
  });
});

describe("connector real filesystem boundaries", () => {
  it("sorts directories and files and retains null size for broken links", async () => {
    await mkdir(path.join(root, "z-dir"));
    await mkdir(path.join(root, "a-dir"));
    await writeFile(path.join(root, "z-file"), "zzz");
    await writeFile(path.join(root, "a-file"), "a");
    await symlink(path.join(root, "missing"), path.join(root, "broken"));
    const result = await createRuntime(root).handle(null, "list_dir", {});
    if (!("entries" in result)) throw new Error("Expected directory listing");
    expect(result.entries.map((entry: { name: string }) => entry.name)).toEqual(
      ["a-dir", "z-dir", "a-file", "broken", "z-file"],
    );
    expect(
      result.entries.find((entry: { name: string }) => entry.name === "broken"),
    ).toMatchObject({ type: "file", size: null });
  });
  it("refuses directory download/deletion and oversized downloads", async () => {
    const runtime = createRuntime(root);
    await expect(runtime.handle(null, "download_file", {})).rejects.toThrow(
      "Path is not a file",
    );
    await expect(runtime.handle(null, "delete_file", {})).rejects.toThrow(
      "Path is not a file",
    );
    await writeFile(path.join(root, "large"), Buffer.alloc(5000001));
    await expect(
      runtime.handle(null, "download_file", { path: "large" }),
    ).rejects.toThrow("too large to download");
  });
  it("writes nested binary assets and removes only the requested file", async () => {
    const runtime = createRuntime(root);
    await expect(
      runtime.handle(null, "write_file_base64", {
        path: "nested/data",
        content: "AP8=",
      }),
    ).resolves.toEqual({ path: "nested/data", bytes: 2 });
    expect(await readFile(path.join(root, "nested/data"))).toEqual(
      Buffer.from([0, 255]),
    );
    await expect(
      runtime.handle(null, "delete_file", { path: "nested/data" }),
    ).resolves.toEqual({ path: "nested/data", deleted: true });
    await expect(
      readFile(path.join(root, "nested/data")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([
    { encoding: "hex", content: "00" },
    { encoding: "base64", content: "a" },
    { encoding: "base64", content: "!!!!" },
    { content: "x".repeat(2000001) },
  ])("rejects invalid content without creating the file", async (args) => {
    await expect(
      createRuntime(root).handle(null, "write_file", { path: "new", ...args }),
    ).rejects.toThrow();
    await expect(readFile(path.join(root, "new"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("refuses virtual traversal and writes through symlinks outside its root", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "connector-outside-"));
    try {
      await symlink(outside, path.join(root, "escape"));
      const runtime = createRuntime(root);
      await expect(
        runtime.handle(null, "write_file", {
          path: "escape/new",
          content: "no",
        }),
      ).rejects.toThrow("through a link");
      await expect(
        runtime.handle(null, "write_file", { path: "../new", content: "no" }),
      ).rejects.toThrow("escapes connector root");
      await expect(
        runtime.handle(null, "read_file", { path: "bad\0" }),
      ).rejects.toThrow("Invalid path");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("connector argument edge cases", () => {
  it.each([[], ["--help"], ["-h"]])(
    "supports help without creating a runtime",
    (...argv) => {
      expect(parseArgs(argv)).toEqual({ help: true });
    },
  );
  it.each([undefined, null, "", "bad/serial"])(
    "rejects invalid Android selector %j",
    (value) => {
      expect(() => validateAndroidSelector(value)).toThrow();
    },
  );
  it.each([undefined, null, "", "127.0.0.1:65536"])(
    "rejects invalid VNC target %j",
    (value) => {
      expect(() => parseVncEndpoint(value)).toThrow();
    },
  );
  it("rejects unknown commands", () => {
    expect(() => parseArgs(["install"])).toThrow("Unknown connector command");
  });
});
