// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  buildHermesRpcConfig,
  hermesRpcAlias,
  runHermesRpcTurn,
} from "@/lib/agents/hermes-rpc";
import type { HermesRpcIO } from "@/lib/agents/hermes-rpc";
import type { RunSandboxAgentTurnOptions } from "@/lib/agents/sandbox-runtime";

const config = {
  provider: { id: "provider", format: "openai", name: "provider" },
  modelId: "model",
  modelProxyBase: "https://proxy.invalid",
  token: "scoped-token",
  skillRoot: "/skills",
  mcpServers: [],
};
const context = {
  container: "isolated",
  workdir: "/workspace",
  stateRoot: "/state",
  skillRoot: "/skills",
  mcpServers: [{ deploymentId: "deployment", url: "https://mcp.invalid" }],
  history: [],
  message: "question",
};

function fixture(frames: string[], executionError?: Error) {
  const options: RunSandboxAgentTurnOptions = {
    ...config,
    runtimeKind: "hermes-rpc",
    workspaceId: "workspace",
    agentId: "agent",
    sandboxId: "sandbox",
    runtimeAccessToken: config.token,
    contextWindow: 8192,
    messages: [],
    onTextDelta: vi.fn(),
    onUsage: vi.fn(),
    onContextUsage: vi.fn(),
    onCommands: vi.fn(),
  };
  const io: HermesRpcIO = {
    exec: vi.fn(async (call) => {
      if (call.executable === "node") {
        for (const frame of frames) await call.onStdout?.(frame);
        if (executionError) throw executionError;
      }
      return "";
    }),
    write: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    prepareSkills: vi.fn(async () => {}),
    activities: vi.fn(async () => {}),
  };
  return { options, io };
}

describe("Hermes RPC trust boundaries and framing", () => {
  it.each([
    "file:///tmp/x",
    "https://u@proxy.invalid",
    "https://:pass@proxy.invalid",
    "https://proxy.invalid?q=x",
    "https://proxy.invalid/#x",
  ])("rejects proxy URL %s", (modelProxyBase) => {
    expect(() => buildHermesRpcConfig({ ...config, modelProxyBase })).toThrow(
      "Invalid Hermes RPC model proxy URL",
    );
  });
  it.each([
    "https://u@mcp.invalid",
    "https://:pass@mcp.invalid",
    "https://mcp.invalid/#x",
  ])("rejects MCP URL %s", (url) => {
    expect(() =>
      buildHermesRpcConfig({
        ...config,
        mcpServers: [{ deploymentId: "d", url }],
      }),
    ).toThrow("Invalid Hermes RPC MCP URL");
  });
  it.each([
    [undefined, 100],
    [Number.NaN, 100],
    [0, 1],
    [-20, 1],
    [4.9, 4],
    [1001, 1000],
  ])("bounds turn limit %s", (maxSteps, expected) => {
    expect(buildHermesRpcConfig({ ...config, maxSteps }).config.agent).toEqual({
      max_turns: expected,
      system_prompt: "",
    });
  });
  it("assembles split frames, consumes final unterminated result and normalizes usage", async () => {
    const { options, io } = fixture([
      '\n  \n{"type":"delta",',
      '"text":"hello"}\n',
      `${JSON.stringify({ type: "commands" })}\n`,
      JSON.stringify({
        type: "result",
        text: "result",
        usage: { input: -1, output: 3, context_used: 10 },
      }),
    ]);
    options.contextWindowEstimated = true;
    options.nativeApprovalUrl = "https://approval.invalid";
    options.runtimeSessionId = "persistent-session";
    expect(await runHermesRpcTurn(options, context, io)).toBe("result");
    expect(options.onTextDelta).toHaveBeenCalledWith("hello");
    expect(options.onUsage).toHaveBeenCalledWith({
      inputTokens: 0,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(options.onContextUsage).toHaveBeenCalledWith({
      usedTokens: 10,
      maxTokens: 8192,
      modelName: "model",
      estimated: true,
    });
    expect(options.onCommands).toHaveBeenCalledWith([
      { name: "compact", description: "Compress the native Hermes session." },
    ]);
    expect(io.remove).toHaveBeenCalledOnce();
  });
  it.each([
    undefined,
    { input: "1", output: 2 },
    { input: 1, output: "2" },
    { context_used: 0 },
    { context_used: -1 },
  ])("ignores unavailable usage %j", async (usage) => {
    const { options, io } = fixture([
      JSON.stringify({ type: "result", text: "", usage }),
    ]);
    expect(await runHermesRpcTurn(options, context, io)).toBe("");
    expect(options.onUsage).not.toHaveBeenCalled();
    expect(options.onContextUsage).not.toHaveBeenCalled();
  });
  it("maps delegated MCP tools and preserves ordinary activities", async () => {
    const activities = [
      {
        type: "tool",
        status: "running",
        toolName: "tool_call",
        input: { name: `mcp__${hermesRpcAlias("deployment")}__search` },
      },
      {
        type: "tool",
        status: "completed",
        toolName: "tool_call",
        input: { name: 1 },
      },
      { type: "tool", status: "completed", toolName: "read_file" },
    ];
    const { options, io } = fixture([
      ...activities.map(
        (activity) => `${JSON.stringify({ type: "activity", activity })}\n`,
      ),
      `${JSON.stringify({ type: "activity", activity: { type: "reasoning" } })}\n`,
      JSON.stringify({ type: "result", text: "ok" }),
    ]);
    expect(await runHermesRpcTurn(options, context, io)).toBe("ok");
    expect(io.activities).toHaveBeenCalledTimes(3);
    expect(io.activities).toHaveBeenNthCalledWith(1, [
      expect.objectContaining({
        deploymentId: "deployment",
        originalToolName: "search",
      }),
    ]);
  });
  it.each([
    [[], "without a successful result"],
    [
      [JSON.stringify({ type: "result", text: 1 })],
      "without a successful result",
    ],
    [[JSON.stringify({ type: "error" })], "Hermes RPC failed"],
    [[JSON.stringify({ type: "error", message: "denied" })], "denied"],
    [["x".repeat(4 * 1024 * 1024 + 1)], "frame limit exceeded"],
  ])("cleans up unsuccessful streams", async (frames, error) => {
    const { options, io } = fixture(frames);
    await expect(runHermesRpcTurn(options, context, io)).rejects.toThrow(error);
    expect(io.remove).toHaveBeenCalledOnce();
  });
  it("prefers protocol failure over process failure and releases admission", async () => {
    const { options, io } = fixture(
      [`${JSON.stringify({ type: "error", message: "native denied" })}\n`],
      new Error("process exit"),
    );
    await expect(runHermesRpcTurn(options, context, io)).rejects.toThrow(
      "native denied",
    );
    const next = fixture([], new Error("process exit"));
    await expect(
      runHermesRpcTurn(next.options, context, next.io),
    ).rejects.toThrow("process exit");
  });
  it("rejects already aborted work before external writes", async () => {
    const { options, io } = fixture([]);
    options.signal = AbortSignal.abort();
    await expect(runHermesRpcTurn(options, context, io)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(io.write).not.toHaveBeenCalled();
    expect(io.remove).toHaveBeenCalledOnce();
  });
});
