import { assertDefined } from "../assert-defined";
import { EventEmitter, once } from "node:events";
import { Duplex, PassThrough, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Net from "node:net";
import type * as ChildProcess from "node:child_process";
import type * as DnsPromises from "node:dns/promises";

const transport = vi.hoisted(() => ({
  spawn: vi.fn(),
  lookup: vi.fn(),
  connect: vi.fn(),
  owner: vi.fn(),
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof ChildProcess>();
  return {
    ...actual,
    spawn: transport.spawn,
    default: { ...actual, spawn: transport.spawn },
  };
});
vi.mock("node:dns/promises", async (original) => {
  const actual = await original<typeof DnsPromises>();
  return {
    ...actual,
    lookup: transport.lookup,
    default: { ...actual, lookup: transport.lookup },
  };
});
vi.mock("node:net", async (original) => {
  const actual = await original<typeof Net>();
  return {
    ...actual,
    createConnection: transport.connect,
    default: { ...actual, createConnection: transport.connect },
  };
});
vi.mock("@/lib/runtime/ownership-state", () => ({
  assertRuntimeOwner: transport.owner,
}));
vi.mock("@/lib/market/skills", () => ({
  MarketError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
import { capturePiPackage } from "@/lib/market/pi-package-source";

class Tunnel extends Duplex {
  written = 0;
  _read() {}
  _write(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ) {
    this.written += chunk.length;
    callback();
  }
}
class Container extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  frames: Record<string, unknown>[] = [];
  receivedBytes = 0;
  onFrame?: (frame: Record<string, unknown>) => void;
  stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      const frame = JSON.parse(chunk.toString());
      if (frame.type === "data")
        this.receivedBytes += Buffer.from(frame.data, "base64").length;
      else this.frames.push(frame);
      this.onFrame?.(frame);
      callback();
    },
  });
  kill = vi.fn(() => {
    this.stdout.destroy();
    this.stdin.destroy();
    queueMicrotask(() => this.emit("close", 137));
    return true;
  });
  emitFrame(frame: unknown) {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }
  finish() {
    this.stdout.end();
    queueMicrotask(() => this.emit("close", 0));
  }
}
const body = Buffer.from("export default function extension() {}\n");
function fixture(requested = "npm:fixture@1.0.0") {
  return {
    source: {
      kind: "npm",
      requested,
      name: "fixture",
      version: "1.0.0",
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    },
    name: "fixture",
    version: "1.0.0",
    root: "package",
    runtime: {
      kind: "pi-sdk",
      piVersion: "0.87.1",
      nodeMajor: 24,
      platform: "linux",
      arch: "arm64",
    },
    resources: {
      extensions: ["package/index.ts"],
      skills: [] as string[],
      prompts: [],
      themes: [],
    },
    entries: [
      { type: "directory", path: "package" },
      {
        type: "file",
        path: "package/index.ts",
        contentEncoding: "base64",
        content: body.toString("base64"),
        executable: false,
        sha256: createHash("sha256").update(body).digest("hex"),
      },
    ],
  };
}
function sendSnapshot(
  container: Container,
  value: unknown = fixture(),
  digest?: string,
) {
  const json = Buffer.from(JSON.stringify(value));
  container.emitFrame({
    type: "snapshot_chunk",
    data: json.toString("base64"),
  });
  container.emitFrame({
    type: "snapshot_end",
    sha256: digest ?? createHash("sha256").update(json).digest("hex"),
  });
  container.finish();
}
let container: Container | undefined;
let tunnel: Tunnel | undefined;
let start: (child: Container, source: string) => void;

beforeEach(() => {
  vi.clearAllMocks();
  container = undefined;
  tunnel = undefined;
  start = () => undefined;
  transport.owner.mockImplementation(() => undefined);
  transport.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  transport.connect.mockImplementation(() => {
    tunnel = new Tunnel();
    queueMicrotask(() => assertDefined(tunnel).emit("connect"));
    return tunnel;
  });
  transport.spawn.mockImplementation((_command: string, args: string[]) => {
    if (args[0] !== "run") {
      const child = new EventEmitter();
      Object.assign(child, { kill: vi.fn() });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }
    container = new Container();
    queueMicrotask(() =>
      start(assertDefined(container), assertDefined(args.at(-1))),
    );
    return container;
  });
});
afterEach(() => {
  vi.useRealTimers();
  tunnel?.destroy();
});

describe("Pi package capture trust boundary", () => {
  it("returns the complete validated immutable snapshot only after clean exit", async () => {
    start = (child) => sendSnapshot(child);
    expect(await capturePiPackage("npm:fixture@1.0.0")).toEqual(fixture());
  });
  it("freezes a public npm range while retaining its requested expression", async () => {
    const requested = "npm:fixture@>=1.0.0 <2.0.0";
    start = (child) => sendSnapshot(child, fixture(requested));
    expect(await capturePiPackage(requested)).toEqual(fixture(requested));
  });
  it.each([
    "git:code.example/owner/repo.git@main",
    "git:https://code.example/owner/repo.git@main",
    "git@code.example:owner/repo.git@main",
  ])(
    "normalizes public Pi Git syntax %s without losing the requested source or ref",
    async (requested) => {
      const expected = {
        ...fixture(),
        source: {
          kind: "git",
          requested,
          url: "https://code.example/owner/repo.git",
          commit: "a".repeat(40),
        },
      };
      start = (child) => sendSnapshot(child, expected);
      expect(await capturePiPackage(requested)).toEqual(expected);
    },
  );
  it("passes private credentials through trusted stdin, never Docker arguments or environment", async () => {
    const value = fixture();
    Object.assign(value.source, {
      registry: "https://registry.example/private/",
    });
    start = (child) => sendSnapshot(child, value);
    await capturePiPackage("npm:fixture@1.0.0", {
      registry: "https://registry.example/private/",
      authentication: {
        url: "https://registry.example/private/",
        authorization: "Bearer capture-secret",
      },
    });
    expect(JSON.stringify(transport.spawn.mock.calls)).not.toContain(
      "capture-secret",
    );
    expect(
      assertDefined(container).frames.find(
        (frame) => frame.type === "configuration",
      ),
    ).toMatchObject({
      authentication: { authorization: "Bearer capture-secret" },
    });
  });
  it("rejects 17 pending CONNECT requests before DNS can allocate sockets", async () => {
    transport.lookup.mockReturnValue(Promise.withResolvers().promise);
    start = (child) => {
      for (let index = 0; index < 17; index++)
        child.emitFrame({
          type: "connect",
          id: `connection-${index}`,
          host: "registry.example",
          port: 443,
        });
    };
    await expect(capturePiPackage("npm:fixture")).rejects.toMatchObject({
      code: "package_capture_failed",
    });
    expect(transport.connect).not.toHaveBeenCalled();
  });
  it.each([
    "npm:fixture@https://registry.example/a",
    "npm:../a",
    "npm:@scope/a@file:foo",
    "https://user:secret@example.com/a/b",
    "https://example.com/a/b?credential=secret",
    "http://example.com/a/b",
    "file:/tmp/a",
    "https://127.0.0.1/a/b",
  ])("rejects unsafe source %s before starting Docker", async (source) => {
    await expect(capturePiPackage(source)).rejects.toMatchObject({
      code: "package_capture_failed",
    });
    expect(transport.spawn).not.toHaveBeenCalled();
  });
  it("guards runtime ownership before even inspecting images", async () => {
    transport.owner.mockImplementation(() => {
      throw new Error("not owner");
    });
    await expect(capturePiPackage("npm:fixture")).rejects.toThrow("not owner");
    expect(transport.spawn).not.toHaveBeenCalled();
  });
  it("reports absent image with the administrator build command", async () => {
    transport.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 1));
      return child;
    });
    await expect(capturePiPackage("npm:fixture")).rejects.toMatchObject({
      code: "capture_image_missing",
      message: expect.stringContaining(
        "docker build --target pi-package-capture",
      ),
    });
  });
  it("rejects simultaneous capture and releases the mutex after failure", async () => {
    const first = capturePiPackage("npm:fixture");
    await expect(capturePiPackage("npm:fixture")).rejects.toMatchObject({
      code: "capture_busy",
    });
    await vi.waitFor(() => expect(container).toBeDefined());
    assertDefined(container).emitFrame({ type: "close", id: "unknown" });
    await expect(first).rejects.toMatchObject({
      code: "package_capture_failed",
    });
    start = (child) => sendSnapshot(child);
    expect(await capturePiPackage("npm:fixture@1.0.0")).toEqual(fixture());
  });
  it.each([
    { type: "data", id: "unknown", data: "YQ==" },
    { type: "connect", id: "a", host: "example.com", port: 80 },
    { type: "connect", id: "a", host: "example.com", port: 443, extra: true },
    { type: "snapshot_chunk", data: "YQ" },
    { type: "snapshot_chunk", data: "YR==" },
    { type: "snapshot_chunk", data: Buffer.alloc(65537).toString("base64") },
    { type: "snapshot_end", sha256: "0".repeat(64) },
  ])("fails closed on invalid protocol %#", async (frame) => {
    start = (child) => child.emitFrame(frame);
    await expect(capturePiPackage("npm:fixture")).rejects.toMatchObject({
      code: "package_capture_failed",
    });
    expect(assertDefined(container).kill).toHaveBeenCalled();
    expect(
      transport.spawn.mock.calls.some(
        ([, args]) => args[0] === "rm" && args.includes("--force"),
      ),
    ).toBe(true);
  });
  it("bounds an unterminated line before JSON decoding", async () => {
    start = (child) => child.stdout.write(Buffer.alloc(96 * 1024 + 1, 65));
    await expect(capturePiPackage("npm:fixture")).rejects.toMatchObject({
      code: "package_capture_failed",
    });
  });
  it.each(
    [
      [{ address: "127.0.0.1", family: 4 }],
      [{ address: "10.1.2.3", family: 4 }],
      [{ address: "169.254.169.254", family: 4 }],
      [
        { address: "93.184.216.34", family: 4 },
        { address: "192.168.0.1", family: 4 },
      ],
    ].map((results) => ({ results })),
  )("rejects all private and mixed DNS results %#", async ({ results }) => {
    transport.lookup.mockResolvedValue(results);
    start = (child) =>
      child.emitFrame({
        type: "connect",
        id: "one",
        host: "registry.example",
        port: 443,
      });
    await expect(capturePiPackage("npm:fixture")).rejects.toMatchObject({
      code: "package_capture_failed",
    });
    expect(transport.connect).not.toHaveBeenCalled();
  });
  it("pins IPv6 TCP and transfers bytes without TLS interception", async () => {
    transport.lookup.mockResolvedValue([
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    start = (child) => {
      child.onFrame = (frame) => {
        if (frame.type === "connected")
          child.emitFrame({
            type: "data",
            id: "one",
            data: Buffer.from("TLS bytes").toString("base64"),
          });
      };
      child.emitFrame({
        type: "connect",
        id: "one",
        host: "registry.example",
        port: 443,
      });
    };
    const capture = capturePiPackage("npm:fixture@1.0.0");
    await vi.waitFor(() => expect(tunnel?.written).toBe(9));
    expect(transport.connect).toHaveBeenCalledWith({
      host: "2606:4700:4700::1111",
      family: 6,
      port: 443,
    });
    assertDefined(container).emitFrame({ type: "close", id: "one" });
    sendSnapshot(assertDefined(container));
    expect(await capture).toEqual(fixture());
  });
  it("rejects outbound traffic exceeding the actual per-connection byte budget", async () => {
    start = (child) => {
      child.onFrame = (frame) => {
        if (frame.type === "connected") {
          const line = `${JSON.stringify({
            type: "data",
            id: "one",
            data: Buffer.alloc(65536).toString("base64"),
          })}\n`;
          void (async () => {
            for (let i = 0; i < 2049; i++)
              if (!child.stdout.write(line)) await once(child.stdout, "drain");
          })().catch(() => undefined);
        }
      };
      child.emitFrame({
        type: "connect",
        id: "one",
        host: "registry.example",
        port: 443,
      });
    };
    await expect(capturePiPackage("npm:fixture")).rejects.toMatchObject({
      code: "package_capture_failed",
    });
    expect(assertDefined(tunnel).written).toBe(128 * 1024 * 1024);
    expect(assertDefined(tunnel).destroyed).toBe(true);
  }, 30_000);
  it("rejects digest and file-byte tampering even when the outer snapshot digest is valid", async () => {
    const altered = fixture();
    altered.entries[1].content = Buffer.from("altered").toString("base64");
    start = (child) => sendSnapshot(child, altered);
    await expect(capturePiPackage("npm:fixture@1.0.0")).rejects.toMatchObject({
      code: "package_capture_failed",
    });
    start = (child) => sendSnapshot(child, fixture(), "0".repeat(64));
    await expect(capturePiPackage("npm:fixture@1.0.0")).rejects.toMatchObject({
      code: "package_capture_failed",
    });
  });
  it("preserves extension-missing errors without exposing arbitrary container error text", async () => {
    start = (child) =>
      child.emitFrame({ type: "error", code: "pi_extensions_missing" });
    await expect(capturePiPackage("npm:fixture")).rejects.toMatchObject({
      code: "pi_extensions_missing",
    });
  });
  it("accepts a valid Skill-only package without inventing an extension", async () => {
    const value = fixture();
    value.resources.extensions = [];
    value.resources.skills = ["package/SKILL.md"];
    const skill = Buffer.from(
      "---\nname: fixture\ndescription: Fixture skill\n---\nUse this fixture.\n",
    );
    value.entries.push({
      type: "file",
      path: "package/SKILL.md",
      contentEncoding: "base64",
      content: skill.toString("base64"),
      executable: false,
      sha256: createHash("sha256").update(skill).digest("hex"),
    });
    start = (child) => sendSnapshot(child, value);
    expect(await capturePiPackage("npm:fixture@1.0.0")).toEqual(value);
  });
  it("rejects incoming traffic exceeding the same connection budget", async () => {
    transport.connect.mockImplementation(() => {
      tunnel = new Tunnel();
      let blocks = 2050;
      const block = Buffer.alloc(65536);
      assertDefined(tunnel)._read = () => {
        if (blocks-- > 0) assertDefined(tunnel).push(block);
      };
      queueMicrotask(() => assertDefined(tunnel).emit("connect"));
      return tunnel;
    });
    start = (child) =>
      child.emitFrame({
        type: "connect",
        id: "one",
        host: "registry.example",
        port: 443,
      });
    await expect(capturePiPackage("npm:fixture")).rejects.toMatchObject({
      code: "package_capture_failed",
    });
    expect(assertDefined(tunnel).destroyed).toBe(true);
    expect(assertDefined(container).receivedBytes).toBeLessThanOrEqual(
      128 * 1024 * 1024,
    );
  }, 30_000);
  it("enforces the total network budget across connections", async () => {
    transport.connect.mockImplementation(() => {
      const socket = new Tunnel();
      let blocks = 1600;
      const block = Buffer.alloc(65536);
      socket._read = () => {
        if (blocks-- > 0) socket.push(block);
        else socket.push(null);
      };
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    });
    start = (child) => {
      for (const id of ["a", "b", "c"])
        child.emitFrame({
          type: "connect",
          id,
          host: "registry.example",
          port: 443,
        });
    };
    await expect(capturePiPackage("npm:fixture")).rejects.toMatchObject({
      code: "package_capture_failed",
    });
    expect(assertDefined(container).receivedBytes).toBeLessThanOrEqual(
      256 * 1024 * 1024,
    );
  }, 30_000);
  it("never consumes a second upload frame until the socket write is drained", async () => {
    let release!: () => void;
    transport.connect.mockImplementation(() => {
      tunnel = new Tunnel();
      assertDefined(tunnel)._write = (chunk, _encoding, callback) => {
        assertDefined(tunnel).written += chunk.length;
        release = callback;
      };
      queueMicrotask(() => assertDefined(tunnel).emit("connect"));
      return tunnel;
    });
    start = (child) => {
      child.onFrame = (frame) => {
        if (frame.type === "connected") {
          child.emitFrame({ type: "data", id: "one", data: "YQ==" });
          child.emitFrame({ type: "data", id: "one", data: "Yg==" });
        }
      };
      child.emitFrame({
        type: "connect",
        id: "one",
        host: "registry.example",
        port: 443,
      });
    };
    const capture = capturePiPackage("npm:fixture@1.0.0");
    await vi.waitFor(() => expect(tunnel?.written).toBe(1));
    release();
    await vi.waitFor(() => expect(assertDefined(tunnel).written).toBe(2));
    release();
    assertDefined(container).emitFrame({ type: "close", id: "one" });
    sendSnapshot(assertDefined(container));
    expect(await capture).toEqual(fixture());
  });
  it("terminates a capture with no output at the overall deadline", async () => {
    vi.useFakeTimers();
    const capture = capturePiPackage("npm:fixture");
    const rejected = expect(capture).rejects.toMatchObject({
      code: "package_capture_failed",
    });
    await vi.advanceTimersByTimeAsync(300_001);
    await rejected;
    expect(assertDefined(container).kill).toHaveBeenCalled();
  });
  it("stops stalled DNS and force removes the isolated container", async () => {
    vi.useFakeTimers();
    transport.lookup.mockReturnValue(new Promise(() => undefined));
    start = (child) =>
      child.emitFrame({
        type: "connect",
        id: "one",
        host: "registry.example",
        port: 443,
      });
    const capture = capturePiPackage("npm:fixture");
    const rejected = expect(capture).rejects.toMatchObject({
      code: "package_capture_failed",
    });
    await vi.advanceTimersByTimeAsync(15_001);
    await rejected;
    expect(transport.connect).not.toHaveBeenCalled();
    expect(assertDefined(container).kill).toHaveBeenCalled();
  });
});
