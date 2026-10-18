// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), pty: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node-pty", () => ({ default: { spawn: mocks.pty } }));
import {
  createAndroidRuntime,
  resolveAndroidRoot,
  resolveAndroidSerial,
} from "../../packages/connector/bin/android.mjs";

type Reply = {
  output?: string | Buffer;
  stderr?: string;
  code?: number;
  error?: Error & { code?: string };
  hang?: boolean;
};
const replies: Reply[] = [];
const children: Child[] = [];
class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  kill = vi.fn(() => {
    this.finish(null, "SIGKILL");
    return true;
  });
  closed = false;
  finish(code: number | null, signal: string | null = null) {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}
beforeEach(() => {
  vi.resetAllMocks();
  replies.length = 0;
  children.length = 0;
  mocks.spawn.mockImplementation((_command, args) => {
    const child = new Child();
    children.push(child);
    const reply = replies.shift() ?? {
      output: args.at(-1) === "get-state" ? "device\n" : "",
    };
    child.stdin.on("finish", () =>
      queueMicrotask(() => {
        if (reply.hang) return;
        if (reply.output) child.stdout.write(reply.output);
        if (reply.stderr) child.stderr.write(reply.stderr);
        if (reply.error) child.emit("error", reply.error);
        child.finish(reply.code ?? 0);
      }),
    );
    child.stdin.resume();
    return child;
  });
});
afterEach(() => vi.useRealTimers());
const ws = { readyState: 1, send: vi.fn() };
const start = () => createAndroidRuntime("/sdcard/ToolPlane", "device-one");

describe("Android terminal lifecycle and cancellation", () => {
  it("forwards terminal events only to open sockets and removes exited sessions", async () => {
    const runtime = await start();
    let onData: (data: string) => void = () => undefined;
    let onExit: (event: { exitCode: number; signal?: number }) => void = () =>
      undefined;
    const term = {
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
    mocks.pty.mockReturnValue(term);
    const socket = { readyState: 1, send: vi.fn() };
    const created = await runtime.handle(socket, "terminal_create", {
      cols: 500,
      rows: 1,
    });
    if (!("terminalId" in created))
      throw new Error("Expected terminal session");
    const { terminalId } = created;
    expect(mocks.pty.mock.calls[0][2]).toMatchObject({ cols: 240, rows: 6 });
    onData("hello");
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      type: "terminal_data",
      terminalId,
      data: "hello",
    });
    await runtime.handle(socket, "terminal_input", {
      terminalId,
      data: "x".repeat(2000001),
    });
    expect(term.write).toHaveBeenCalledWith("x".repeat(2000000));
    await runtime.handle(socket, "terminal_resize", {
      terminalId,
      cols: 1,
      rows: 500,
    });
    expect(term.resize).toHaveBeenCalledWith(20, 80);
    await runtime.handle(socket, "terminal_resize", { terminalId });
    expect(term.resize).toHaveBeenLastCalledWith(80, 24);
    socket.readyState = 3;
    onData("ignored");
    expect(socket.send).toHaveBeenCalledTimes(1);
    socket.readyState = 1;
    onExit({ exitCode: 7 });
    expect(JSON.parse(socket.send.mock.calls[1][0])).toEqual({
      type: "terminal_exit",
      terminalId,
      exitCode: 7,
    });
    await expect(
      runtime.handle(socket, "terminal_input", { terminalId }),
    ).rejects.toThrow("terminal session not found");
    await expect(runtime.handle(socket, "terminal_resize", {})).rejects.toThrow(
      "terminal session not found",
    );
    await expect(
      runtime.handle(socket, "terminal_close", { terminalId }),
    ).resolves.toEqual({ ok: true });
  });
  it("closes sessions idempotently and kills remaining terminals on disconnect", async () => {
    const runtime = await start();
    const term = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    };
    mocks.pty.mockReturnValue(term);
    const first = await runtime.handle(ws, "terminal_create", {});
    if (!("terminalId" in first)) throw new Error("Expected terminal session");
    await runtime.handle(ws, "terminal_input", {
      terminalId: first.terminalId,
    });
    expect(term.write).toHaveBeenCalledWith("");
    await runtime.handle(ws, "terminal_close", first);
    await runtime.handle(ws, "terminal_close", first);
    expect(term.kill).toHaveBeenCalledTimes(1);
    await runtime.handle(ws, "terminal_create", { env: [] });
    runtime.closeAllTerminals();
    runtime.closeAllTerminals();
    expect(term.kill).toHaveBeenCalledTimes(2);
  });
  it("times out stalled ADB commands rather than leaving requests pending", async () => {
    const runtime = await start();
    vi.useFakeTimers();
    replies.push({ hang: true });
    const pending = runtime.handle(ws, "screen_capture", { timeoutMs: 5 });
    const assertion = expect(pending).rejects.toThrow(
      "Android screen capture timed out.",
    );
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
    expect(children.at(-1)?.kill).toHaveBeenCalledWith("SIGKILL");
  });
  it("kills active child processes when its connection closes", async () => {
    const runtime = await start();
    replies.push({ hang: true });
    const pending = runtime.handle(ws, "screen_capture", {});
    const assertion = expect(pending).rejects.toThrow(
      "Android screen capture failed.",
    );
    runtime.closeAllTerminals();
    await assertion;
    expect(children.at(-1)?.kill).toHaveBeenCalledOnce();
  });
});

describe("Android connector validation", () => {
  it.each([
    "",
    "relative",
    "/",
    " ",
    "/root\nfile",
    "/root\0file",
    "/" + "a".repeat(1024),
  ])("rejects unsafe root %j", (root) => {
    if (root === "") expect(resolveAndroidRoot(root)).toBe("/sdcard/ToolPlane");
    else expect(() => resolveAndroidRoot(root)).toThrow();
  });
  it("resolves home aliases, bootstrap roots and normalized absolute paths", () => {
    expect(resolveAndroidRoot("~")).toBe("/data/local/tmp");
    expect(resolveAndroidRoot("~/files")).toBe("/data/local/tmp/files");
    expect(resolveAndroidRoot(undefined, "/sdcard/base/../files")).toBe(
      "/sdcard/files",
    );
  });
  it.each(["", "offline\n"])(
    "rejects a selected device which is not ready: %j",
    async (output) => {
      replies.push({ output });
      await expect(resolveAndroidSerial("device-one")).rejects.toThrow(
        "is not ready",
      );
    },
  );
  it("filters offline, unauthorized and invalid serials during discovery", async () => {
    replies.push({
      output:
        "List of devices attached\nbad/serial\tdevice\noffline\toffline\nlocked\tunauthorized\nready-one\tdevice product:pixel\n",
    });
    await expect(resolveAndroidSerial("auto")).resolves.toBe("ready-one");
    replies.push({
      output: "List of devices attached\nlocked\tunauthorized\n",
    });
    await expect(resolveAndroidSerial("auto")).rejects.toThrow("No authorized");
    replies.push({ output: "one\tdevice\ntwo\tdevice\n" });
    await expect(resolveAndroidSerial("auto")).rejects.toThrow("More than one");
  });
  it("reports ADB launch errors and rejects nul executable names", async () => {
    const error = Object.assign(new Error("spawn adb ENOENT"), {
      code: "ENOENT",
    });
    replies.push({ error });
    await expect(resolveAndroidSerial("auto")).rejects.toThrow(
      "spawn adb ENOENT",
    );
    await expect(
      resolveAndroidSerial("auto", {
        env: { TOOLPLANE_CONNECTOR_ADB: "bad\0path" },
      }),
    ).rejects.toThrow("Invalid ADB executable");
  });
  it.each([
    {},
    { command: "" },
    { command: "x\0y" },
    { command: "x".repeat(24001) },
  ])("rejects unbounded shell commands", async (args) => {
    const runtime = await start();
    await expect(runtime.handle(ws, "shell_exec", args)).rejects.toThrow(
      "command is required and must be bounded",
    );
  });
  it.each(["../escape", "bad\npath", "bad\0path", "a".repeat(1025), "."])(
    "rejects unsafe file path %j",
    async (path) => {
      const runtime = await start();
      await expect(runtime.handle(ws, "read_file", { path })).rejects.toThrow();
    },
  );
  it.each([
    {},
    { runtime: "ruby" },
    { runtime: "node", args: "bad" },
    { runtime: "node", args: [1] },
    { runtime: "node", args: ["nul\0"] },
    { runtime: "node", args: ["a".repeat(8193)] },
    { runtime: "node", args: Array(129).fill("a") },
    { runtime: "node", args: Array(4).fill("a".repeat(8000)) },
  ])("rejects invalid process execution arguments", async (args) => {
    const runtime = await start();
    await expect(runtime.handle(ws, "process_exec", args)).rejects.toThrow();
  });
});

describe("Android connector file and process behavior", () => {
  it("provides fallback metadata and verifies device liveness on ping", async () => {
    const runtime = await start();
    expect(runtime.info).toMatchObject({
      arch: "unknown",
      device: { name: "device-one" },
      platform: "android",
    });
    await expect(runtime.handle(ws, "ping", {})).resolves.toMatchObject({
      ok: true,
    });
    replies.push({ output: "offline" });
    await expect(runtime.handle(ws, "ping", {})).rejects.toThrow(
      "Android device is not ready",
    );
    await expect(runtime.handle(ws, "unknown", {})).rejects.toThrow(
      "Unknown connector op",
    );
  });
  it("parses NUL-delimited listings and sorts directories before files", async () => {
    const runtime = await start();
    replies.push(
      {},
      {
        output: [
          "z.txt",
          "file",
          "3",
          "beta",
          "dir",
          "",
          "alpha",
          "dir",
          "",
          "a.txt",
          "file",
          "1",
          "",
        ].join("\0"),
      },
    );
    const result = await runtime.handle(ws, "list_dir", {});
    expect(result).toEqual({
      path: ".",
      entries: [
        { name: "alpha", type: "dir", size: null },
        { name: "beta", type: "dir", size: null },
        { name: "a.txt", type: "file", size: 1 },
        { name: "z.txt", type: "file", size: 3 },
      ],
    });
    replies.push({}, { output: "malformed\0file\0" });
    await expect(runtime.handle(ws, "list_dir", {})).rejects.toThrow(
      "malformed",
    );
  });
  it("rejects symlink escapes before reading a file", async () => {
    const runtime = await start();
    replies.push({ code: 42 });
    await expect(
      runtime.handle(ws, "read_file", { path: "link/file" }),
    ).rejects.toThrow("escapes Android connector root through a link");
  });
  it("reads text with bounded truncation and downloads binary content", async () => {
    const runtime = await start();
    replies.push({}, { output: "hello" });
    await expect(
      runtime.handle(ws, "read_file", { path: "note.txt" }),
    ).resolves.toEqual({ path: "note.txt", content: "hello" });
    replies.push({}, { output: "a".repeat(128001) });
    const truncated = await runtime.handle(ws, "read_file", {
      path: "large.txt",
    });
    if (!("content" in truncated)) throw new Error("Expected file content");
    expect(truncated.content).toBe("a".repeat(128000) + "\n[output truncated]");
    replies.push({}, { output: Buffer.from([0, 255, 1]) });
    await expect(
      runtime.handle(ws, "download_file", { path: "folder/file.bin" }),
    ).resolves.toEqual({
      path: "folder/file.bin",
      filename: "file.bin",
      encoding: "base64",
      content: "AP8B",
      size: 3,
    });
    replies.push({}, { output: Buffer.alloc(5000001) });
    await expect(
      runtime.handle(ws, "download_file", { path: "large.bin" }),
    ).rejects.toThrow("too large to download");
  });
  it.each([
    { encoding: "hex", content: "00" },
    { encoding: "base64", content: "abc" },
    { encoding: "base64", content: "!!!!" },
    { content: "a".repeat(2000001) },
  ])("rejects invalid file content before writing", async (args) => {
    const runtime = await start();
    replies.push({});
    await expect(
      runtime.handle(ws, "write_file", { path: "file", ...args }),
    ).rejects.toThrow();
  });
  it("writes UTF-8 and base64 data and deletes files", async () => {
    const runtime = await start();
    await expect(
      runtime.handle(ws, "write_file", { path: "note", content: "é" }),
    ).resolves.toEqual({ path: "note", bytes: 2 });
    await expect(
      runtime.handle(ws, "write_file_base64", {
        path: "binary",
        content: "AP8B",
      }),
    ).resolves.toEqual({ path: "binary", bytes: 3 });
    await expect(
      runtime.handle(ws, "delete_file", { path: "note" }),
    ).resolves.toEqual({ path: "note", deleted: true });
  });
  it.each(["node", "python", "bash"])(
    "reports unavailable %s without inventing an executable",
    async (runtimeName) => {
      const runtime = await start();
      replies.push({}, { code: 127, stderr: "runtime absent" });
      await expect(
        runtime.handle(ws, "process_exec", { runtime: runtimeName, args: [] }),
      ).resolves.toMatchObject({
        runtime: runtimeName,
        executable: null,
        errorCode: "RUNTIME_UNAVAILABLE",
        exitCode: 127,
      });
      replies.push({}, { output: "ok", stderr: "warning" });
      await expect(
        runtime.handle(ws, "process_exec", { runtime: runtimeName }),
      ).resolves.toMatchObject({
        stdout: "ok",
        stderr: "warning",
        executable: runtimeName === "bash" ? "sh" : runtimeName,
        exitCode: 0,
      });
    },
  );
  it("bounds shell output and strips invalid environment entries", async () => {
    const runtime = await start();
    replies.push(
      {},
      { output: "x".repeat(128001), stderr: "e".repeat(128001) },
    );
    const result = await runtime.handle(ws, "shell_exec", {
      command: "printf value",
      env: {
        GOOD: "ok",
        "bad-key": "bad",
        NUL: "bad\0",
        LONG: "a".repeat(8193),
        NUMBER: 5,
      },
    });
    if (!("stdout" in result) || !("stderr" in result)) {
      throw new Error("Expected shell output");
    }
    expect(result.stdout).toBe("x".repeat(128000) + "\n[output truncated]");
    expect(result.stderr).toBe("e".repeat(128000) + "\n[output truncated]");
    const command = mocks.spawn.mock.calls.at(-1)?.[1].at(-1);
    expect(command).toContain("GOOD");
    expect(command).not.toContain("bad-key");
    expect(command).not.toContain("NUL");
    expect(command).not.toContain("NUMBER");
  });
  it("validates screenshot display and PNG data and rejects oversized output", async () => {
    const runtime = await start();
    await expect(
      runtime.handle(ws, "screen_capture", { displayId: "other" }),
    ).rejects.toThrow("Unknown display");
    replies.push({ output: "short" });
    await expect(runtime.handle(ws, "screen_capture", {})).rejects.toThrow(
      "did not return a PNG",
    );
    replies.push({ output: "not a png image" });
    await expect(runtime.handle(ws, "screen_capture", {})).rejects.toThrow(
      "did not return a PNG",
    );
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    replies.push({ output: png });
    await expect(runtime.handle(ws, "screen_capture", {})).resolves.toEqual({
      data: png.toString("base64"),
      contentType: "image/png",
      size: 8,
    });
    replies.push({ output: Buffer.alloc(5000001) });
    await expect(runtime.handle(ws, "screen_capture", {})).rejects.toThrow(
      "output is too large",
    );
  });
});
