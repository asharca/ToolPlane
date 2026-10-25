// @vitest-environment node
import { EventEmitter } from "node:events";
import { readFileSync, statSync } from "node:fs";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  result: "",
  staged: [] as { name: string; content: string; mode: number }[],
  directoryMode: 0,
  input: "",
}));
vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
  spawn: mocks.spawn,
}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/process/supervisor", () => ({ effectiveStatus: vi.fn() }));
vi.mock("@/lib/sandboxes/runtime", () => ({ sandboxContainerName: vi.fn() }));
vi.mock("@/lib/agents/conversation-sandbox", () => ({
  findAgentConversationSandbox: vi.fn(),
}));
vi.mock("@/lib/runtime/ownership-state", () => ({
  assertRuntimeOwner: vi.fn(),
  trackRuntimeOperation: (operation: () => unknown) => operation(),
  runtimeAbortSignal: () => undefined,
  markRuntimeUncertain: vi.fn(),
}));
import { preflightPiSdkCapabilities } from "@/lib/agents/sandbox-runtime";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.result = JSON.stringify({
    commands: [],
    tools: [],
    prompts: [],
    skills: [],
  });
  mocks.staged = [];
  mocks.input = "";
  mocks.execFile.mockImplementation(
    (
      _binary: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      if (args[0] === "create") {
        const mount = args[args.indexOf("--mount") + 1];
        const directory = mount
          .split(",")
          .find((part) => part.startsWith("source="))
          ?.slice("source=".length);
        if (!directory) throw new Error("Missing isolated helper mount");
        mocks.directoryMode = statSync(directory).mode & 0o777;
        for (const name of [
          "pi-sdk-preflight.mjs",
          "pi-sdk-capabilities.mjs",
          "pi-sdk-package-files.mjs",
        ])
          mocks.staged.push({
            name,
            content: readFileSync(`${directory}/${name}`, "utf8"),
            mode: statSync(`${directory}/${name}`).mode & 0o777,
          });
      }
      queueMicrotask(() =>
        callback(null, args[0] === "start" ? mocks.result : "created"),
      );
      return {
        stdin: {
          end: (input?: string) => {
            if (args[0] === "start") mocks.input = input ?? "";
          },
        },
      };
    },
  );
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      child.emit("exit", 0);
      child.emit("close", 0);
    });
    return child;
  });
});

describe("isolated native capability preflight process boundary", () => {
  it("stages the actual helper modules before mounting them read-only into the hardened container", async () => {
    await expect(
      preflightPiSdkCapabilities({ toolNames: ["mcp__s0_t0__read"] }),
    ).resolves.toEqual({ commands: [], tools: [], prompts: [], skills: [] });
    const create = mocks.execFile.mock.calls.find(
      (call) => call[1][0] === "create",
    )?.[1] as string[];
    expect(create).toEqual(
      expect.arrayContaining([
        "--read-only",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "no-new-privileges",
        "/tmp:rw,nosuid,nodev,mode=1777,size=256m",
        "/opt/toolplane-preflight/pi-sdk-preflight.mjs",
      ]),
    );
    expect(create[create.indexOf("--mount") + 1]).toMatch(
      /target=\/opt\/toolplane-preflight,readonly$/,
    );
    expect(mocks.directoryMode).toBe(0o755);
    expect(mocks.staged).toHaveLength(3);
    for (const file of mocks.staged) {
      expect(file.content).toBe(readFileSync(`scripts/${file.name}`, "utf8"));
      expect(file.mode).toBe(0o444);
    }
    expect(mocks.execFile.mock.calls.some((call) => call[1][0] === "cp")).toBe(
      false,
    );
    expect(JSON.parse(mocks.input)).toMatchObject({
      packages: [],
      skills: [],
      toolNames: ["mcp__s0_t0__read"],
    });
    expect(mocks.spawn).toHaveBeenCalledWith(
      "docker",
      ["rm", "-f", expect.stringMatching(/^toolplane-pi-preflight-/)],
      expect.anything(),
    );
  });
  it("preserves a native collision result as a capability conflict", async () => {
    mocks.result = JSON.stringify({ error: "PI_CAPABILITY_CONFLICT" });
    await expect(preflightPiSdkCapabilities({})).rejects.toThrow(
      "PI_CAPABILITY_CONFLICT",
    );
    expect(mocks.spawn).toHaveBeenCalled();
  });
});
