// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSandboxAgentTurnOptions } from "@/lib/agents/sandbox-runtime";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  findSandbox: vi.fn(),
  output: "",
  failure: "",
  missingInstall: false,
  refreshSkills: false,
  writes: [] as string[],
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@/lib/db", () => ({
  db: {
    agentSandbox: { findUnique: mocks.findSandbox },
    a2ATask: {
      findFirst: vi.fn(async () => ({ context: { agentId: "agent-1" } })),
    },
    sandbox: {
      findFirst: vi.fn(async () => ({
        network: "bridge",
        deploymentId: "sandbox-deployment",
        deployment: { status: "running" },
      })),
    },
  },
}));
vi.mock("@/lib/agents/conversation-sandbox", () => ({
  findAgentConversationSandbox: vi.fn(async () => ({
    sandboxId: "sandbox-1",
    deploymentId: "sandbox-deployment",
  })),
}));
vi.mock("@/lib/process/supervisor", () => ({
  effectiveStatus: (_id: string, status: string) => status,
}));
vi.mock("@/lib/sandboxes/runtime", () => ({
  sandboxContainerName: (id: string) => `sandbox-${id}`,
}));
vi.mock("@/lib/agents/sandbox-execution-gate", () => ({
  withSandboxExecutionLease: (_id: string, operation: () => unknown) =>
    operation(),
}));
vi.mock("@/lib/runtime/ownership-state", () => ({
  assertRuntimeOwner: vi.fn(),
  trackRuntimeOperation: (operation: () => unknown) => operation(),
  runtimeAbortSignal: () => undefined,
  markRuntimeUncertain: vi.fn(),
}));
vi.mock("@/lib/workspace/operation-gate", () => ({
  beginWorkspaceOperation: vi.fn(),
}));

import {
  runSandboxAgentTurn,
  preparePiHarnessOperation,
  runPiHarnessOperation,
  cancelPiHarnessOperation,
  compactPiHarnessSession,
} from "@/lib/agents/sandbox-runtime";

const options: RunSandboxAgentTurnOptions = {
  runtimeKind: "pi",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  sandboxId: "sandbox-1",
  provider: { id: "provider-1", name: "Provider", format: "openai" },
  modelId: "model-1",
  contextWindow: 10000,
  modelProxyBase: "http://host.docker.internal:3000/model",
  runtimeAccessToken: "private-runtime-token",
  messages: [
    { role: "user", parts: [{ type: "text", text: "Please inspect" }] },
  ],
};
const events = (...values: unknown[]) =>
  values.map((value) => JSON.stringify(value)).join("\n");

describe("sandbox turn execution and presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.output = "";
    mocks.failure = "";
    mocks.missingInstall = false;
    mocks.refreshSkills = false;
    mocks.writes = [];
    mocks.findSandbox.mockResolvedValue({
      agent: { workspaceId: "workspace-1" },
      sandbox: {
        id: "sandbox-1",
        workspaceId: "workspace-1",
        kind: "docker",
        network: "isolated",
        deploymentId: "sandbox-deployment",
        deployment: { status: "running" },
      },
    });
    mocks.spawn.mockImplementation((_command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      let stdin = "";
      child.stdin.on("data", (chunk) => {
        stdin += chunk.toString();
      });
      const markerIndex = args.indexOf("toolplane-runtime");
      const executable = args[markerIndex + 2] || "";
      const commandArgs = args.slice(markerIndex + 3);
      const turn =
        executable.includes("/node_modules/.bin/") ||
        commandArgs.some((arg) => arg.endsWith("-session.mjs")) ||
        commandArgs.includes("toolplane-dsh");
      queueMicrotask(() => {
        if (commandArgs.includes("toolplane-write")) mocks.writes.push(stdin);
        let output = turn ? mocks.output : "";
        if (commandArgs.includes("toolplane-pi-version")) output = "0.80.3\n";
        if (turn && commandArgs.includes("toolplane-dsh")) {
          const prefix =
            mocks.writes
              .join("\n")
              .match(/__TOOLPLANE_DSH_EVENT_[a-f0-9-]+__/u)?.[0] || "";
          output = output.replaceAll("DSH_EVENT:", prefix);
        }
        const control = args
          .join(" ")
          .match(/__TOOLPLANE_RUNTIME_PID_[a-f0-9-]+__/u)?.[0];
        if (control) child.stdout.write(`${control}123\n`);
        if (output) child.stdout.write(output);
        const missing = mocks.missingInstall && executable === "test";
        if (missing) mocks.missingInstall = false;
        const stale =
          mocks.refreshSkills && commandArgs.includes("toolplane-check-skills");
        if (stale) mocks.refreshSkills = false;
        if (turn && mocks.failure) child.stderr.write(mocks.failure);
        const code = missing || stale || (turn && mocks.failure) ? 1 : 0;
        child.emit("exit", code, null);
        child.emit("close", code, null);
      });
      return child;
    });
  });

  it.each([
    [{ runtimeAccessToken: "" }, "access token"],
    [{ runtimeAccessToken: "bad\nvalue" }, "access token"],
    [{ modelId: " " }, "model"],
    [{ modelId: "bad\0model" }, "model"],
    [{ contextWindow: 0 }, "context window"],
    [{ contextWindow: Number.NaN }, "context window"],
    [{ runtimeSessionId: "../escape" }, "runtime session"],
  ])(
    "rejects invalid turn input %j before accessing sandbox",
    async (override, error) => {
      await expect(
        runSandboxAgentTurn({ ...options, ...override }),
      ).rejects.toThrow(error);
      expect(mocks.findSandbox).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it.each([
    [null, "not assigned"],
    [
      {
        agent: { workspaceId: "foreign" },
        sandbox: { workspaceId: "workspace-1" },
      },
      "not assigned",
    ],
    [
      {
        agent: { workspaceId: "workspace-1" },
        sandbox: { workspaceId: "foreign" },
      },
      "not assigned",
    ],
    [
      {
        agent: { workspaceId: "workspace-1" },
        sandbox: { workspaceId: "workspace-1", kind: "local" },
      },
      "Docker sandbox",
    ],
    [
      {
        agent: { workspaceId: "workspace-1" },
        sandbox: {
          workspaceId: "workspace-1",
          kind: "docker",
          network: "none",
        },
      },
      "networking disabled",
    ],
    [
      {
        agent: { workspaceId: "workspace-1" },
        sandbox: {
          workspaceId: "workspace-1",
          kind: "docker",
          network: "isolated",
          deployment: { status: "stopped" },
        },
      },
      "not running",
    ],
  ])("enforces sandbox assignment and lifecycle %j", async (sandbox, error) => {
    mocks.findSandbox.mockResolvedValue(sandbox);
    await expect(runSandboxAgentTurn(options)).rejects.toThrow(error);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("rejects a turn with no visible prompt before running commands", async () => {
    await expect(
      runSandboxAgentTurn({ ...options, messages: [] }),
    ).rejects.toThrow("no user-visible message");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("streams Pi deltas, redacts credentials, and reports exact usage and failed tools", async () => {
    mocks.output = events(
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "Answer private-runtime-token",
        },
      },
      {
        type: "tool_execution_start",
        toolCallId: "call",
        toolName: "read",
        args: { token: "private-runtime-token" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call",
        toolName: "read",
        result: "private-runtime-token denied",
        isError: true,
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "fallback" }],
          usage: { input: 10, output: 5 },
        },
      },
    );
    const onTextDelta = vi.fn();
    const onActivity = vi.fn();
    const onContextUsage = vi.fn();
    const result = await runSandboxAgentTurn({
      ...options,
      onTextDelta,
      onActivity,
      onContextUsage,
    });
    expect(result).toContain("Answer");
    expect(result).not.toContain(options.runtimeAccessToken);
    expect(onTextDelta).toHaveBeenCalledWith(result);
    expect(onActivity).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", isError: true }),
    );
    expect(JSON.stringify(onActivity.mock.calls)).not.toContain(
      options.runtimeAccessToken,
    );
    expect(onContextUsage).toHaveBeenCalledWith({
      usedTokens: 15,
      maxTokens: 10000,
      modelName: "model-1",
      estimated: false,
    });
  });

  it("uses a final Pi assistant message when no text deltas arrived", async () => {
    mocks.output = events({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final answer" }],
      },
    });
    const onTextDelta = vi.fn();
    const onContextUsage = vi.fn();
    await expect(
      runSandboxAgentTurn({
        ...options,
        systemPrompt: "Be precise",
        mcpServers: [{ deploymentId: "other", url: "http://mcp.test" }],
        onTextDelta,
        onContextUsage,
      }),
    ).resolves.toBe("Final answer");
    expect(onTextDelta).toHaveBeenCalledWith("Final answer");
    expect(onContextUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        estimated: true,
        usedTokens: expect.any(Number),
      }),
    );
  });

  it.each(["pi", "claude-code"] as const)(
    "rejects %s turns without assistant output",
    async (runtimeKind) => {
      await expect(
        runSandboxAgentTurn({ ...options, runtimeKind }),
      ).rejects.toThrow("returned no assistant text");
    },
  );

  it("surfaces redacted Pi runtime errors rather than a partial answer", async () => {
    mocks.output = events({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "private-runtime-token rejected",
      },
    });
    const failure = await runSandboxAgentTurn(options).catch(
      (error: Error) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("rejected");
    expect((failure as Error).message).not.toContain(
      options.runtimeAccessToken,
    );
  });

  it("exposes Claude commands, usage and final result with exact context accounting", async () => {
    mocks.output = events(
      { type: "system", subtype: "init", slash_commands: ["compact"] },
      {
        type: "result",
        result: "Claude answer",
        usage: { input_tokens: 12, output_tokens: 3 },
        total_cost_usd: 0.01,
      },
    );
    const onCommands = vi.fn();
    const onUsage = vi.fn();
    const onTextDelta = vi.fn();
    const onContextUsage = vi.fn();
    await expect(
      runSandboxAgentTurn({
        ...options,
        runtimeKind: "claude-code",
        onCommands,
        onUsage,
        onTextDelta,
        onContextUsage,
      }),
    ).resolves.toBe("Claude answer");
    expect(onCommands).toHaveBeenCalledWith([{ name: "compact" }]);
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 12,
        outputTokens: 3,
        costUsd: 0.01,
      }),
    );
    expect(onTextDelta).toHaveBeenCalledWith("Claude answer");
    expect(onContextUsage).toHaveBeenCalledWith(
      expect.objectContaining({ usedTokens: 15, estimated: false }),
    );
  });

  it("reports Claude runtime result errors instead of treating them as successful text", async () => {
    mocks.output = events({
      type: "result",
      is_error: true,
      result: "permission refused",
    });
    await expect(
      runSandboxAgentTurn({
        ...options,
        runtimeKind: "claude-code",
        mcpServers: [{ deploymentId: "other", url: "http://mcp.test" }],
      }),
    ).rejects.toThrow("permission refused");
  });

  it("supports native session command results without requiring a new user prompt", async () => {
    mocks.output = events({
      type: "toolplane_command_result",
      text: "Compacted",
    });
    const onTextDelta = vi.fn();
    await expect(
      runSandboxAgentTurn({
        ...options,
        runtimeSessionId: "session-1",
        command: "compact",
        messages: [],
        onTextDelta,
      }),
    ).resolves.toBe("Compacted");
    expect(onTextDelta).toHaveBeenCalledWith("Compacted");
  });

  it("returns dsh plain-text fallback and strips credentials", async () => {
    mocks.output = "Result private-runtime-token\n";
    const onTextDelta = vi.fn();
    await expect(
      runSandboxAgentTurn({ ...options, runtimeKind: "dsh", onTextDelta }),
    ).resolves.toMatch(/^Result /);
    expect(JSON.stringify(onTextDelta.mock.calls)).not.toContain(
      options.runtimeAccessToken,
    );
  });

  it("keeps stderr errors bounded to the turn and redacts the runtime token", async () => {
    mocks.failure = "provider private-runtime-token unavailable";
    await expect(runSandboxAgentTurn(options)).rejects.toThrow("unavailable");
    const error = await runSandboxAgentTurn(options).catch(
      (value: Error) => value,
    );
    expect((error as Error).message).not.toContain(options.runtimeAccessToken);
  });

  it("installs a missing runtime and refreshes stale Claude skill metadata before a turn", async () => {
    mocks.missingInstall = true;
    mocks.refreshSkills = true;
    mocks.output = events({ type: "result", result: "Installed" });
    await expect(
      runSandboxAgentTurn({ ...options, runtimeKind: "claude-code" }),
    ).resolves.toBe("Installed");
    expect(
      mocks.spawn.mock.calls.some(([, args]) =>
        args.includes("toolplane-pnpm-install"),
      ),
    ).toBe(true);
    expect(
      mocks.spawn.mock.calls.some(([, args]) =>
        args.includes("toolplane-reset-skills"),
      ),
    ).toBe(true);
  });
  it("delivers SDK terminal text, commands and command result without exposing secrets", async () => {
    mocks.output = events(
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello" },
      },
      {
        type: "toolplane_sdk_response",
        success: true,
        result: {
          text: "Hello world",
          commands: [{ name: "Review" }],
          commandResult: {
            command: "Review",
            text: "private-runtime-token reviewed",
            status: "completed",
          },
        },
      },
    );
    const onTextDelta = vi.fn();
    const onCommands = vi.fn();
    const onCommandResult = vi.fn();
    await expect(
      runSandboxAgentTurn({
        ...options,
        runtimeKind: "pi-sdk",
        onTextDelta,
        onCommands,
        onCommandResult,
      }),
    ).resolves.toBe("Hello world");
    expect(onTextDelta.mock.calls).toEqual([["Hello"], [" world"]]);
    expect(onCommands).toHaveBeenCalledWith([{ name: "Review" }]);
    expect(onCommandResult).toHaveBeenCalledWith(
      expect.objectContaining({ command: "Review", status: "completed" }),
    );
    expect(JSON.stringify(onCommandResult.mock.calls)).not.toContain(
      options.runtimeAccessToken,
    );
  });

  it.each([
    [
      {
        type: "toolplane_sdk_response",
        success: false,
        error: { code: "PI_PACKAGE_UNAVAILABLE" },
      },
      "PI_PACKAGE_UNAVAILABLE",
    ],
    [{ type: "toolplane_sdk_response", success: false }, "PI_SDK_FAILED"],
    [
      {
        type: "toolplane_sdk_response",
        success: true,
        result: {
          text: "partial",
          commandResult: {
            command: "Review",
            text: "failed",
            status: "failed",
          },
        },
      },
      "PI_SDK_COMMAND_FAILED",
    ],
    [
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "partial" },
      },
      "PI_SDK_PROTOCOL_ERROR",
    ],
  ])("fails closed on SDK terminal failure %j", async (event, message) => {
    mocks.output = events(event);
    await expect(
      runSandboxAgentTurn({ ...options, runtimeKind: "pi-sdk" }),
    ).rejects.toThrow(message);
  });

  it("streams dsh process events and a final native command result in order", async () => {
    mocks.output = [
      `DSH_EVENT:${JSON.stringify({ type: "text", delta: "Checking" })}`,
      `DSH_EVENT:${JSON.stringify({ type: "tool", status: "completed", toolCallId: "call", output: "ok" })}`,
      `DSH_EVENT:${JSON.stringify({ type: "commands", commands: [{ name: "goal" }] })}`,
      `DSH_EVENT:${JSON.stringify({ type: "command", text: "Goal set" })}`,
    ].join("\n");
    const onTextDelta = vi.fn();
    const onActivity = vi.fn();
    const onCommands = vi.fn();
    await expect(
      runSandboxAgentTurn({
        ...options,
        runtimeKind: "dsh",
        runtimeSessionId: "session-1",
        onTextDelta,
        onActivity,
        onCommands,
      }),
    ).resolves.toBe("Checking\n\nGoal set");
    expect(onTextDelta.mock.calls).toEqual([["Checking"], ["\n\nGoal set"]]);
    expect(onActivity).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "call", status: "completed" }),
    );
    expect(onCommands).toHaveBeenCalledWith([{ name: "goal" }]);
  });
  describe("round two Pi harness host protocol", () => {
    const binding = {
      contextId: "context",
      operationId: "operation",
      taskId: "task",
    };

    it.each([
      [{ runtimeKind: "dsh" }, "Pi Harness requires"],
      [{ runtimeAccessToken: "" }, "access token"],
      [{ runtimeAccessToken: "a".repeat(8193) }, "access token"],
      [{ runtimeAccessToken: "bad\nsecret" }, "access token"],
      [{ modelId: "" }, "model"],
      [{ modelId: "a".repeat(501) }, "model"],
      [{ modelId: "bad\0model" }, "model"],
      [{ contextWindow: 0 }, "context window"],
      [{ contextWindow: Infinity }, "context window"],
      [{ maxSteps: 0 }, "maxSteps"],
      [{ maxSteps: 1.5 }, "maxSteps"],
      [{ nativeApprovalUrl: "not-url" }, "native approval URL"],
      [{ nativeApprovalUrl: "ftp://host" }, "native approval URL"],
      [
        { nativeApprovalUrl: "https://user:secret@host" },
        "native approval URL",
      ],
      [{ nativeApprovalUrl: "x".repeat(4001) }, "too long"],
    ] as Array<[Partial<RunSandboxAgentTurnOptions>, string]>)(
      "rejects invalid harness input %j before accessing the sandbox",
      async (override, error) => {
        await expect(
          preparePiHarnessOperation({ ...options, ...override }, "context"),
        ).rejects.toThrow(error);
        expect(mocks.findSandbox).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
      },
    );

    it.each(["", "../outside", "x".repeat(201)])(
      "rejects unsafe context ID %s",
      async (contextId) => {
        await expect(
          preparePiHarnessOperation(options, contextId),
        ).rejects.toThrow("Invalid Pi context ID");
        expect(mocks.spawn).not.toHaveBeenCalled();
      },
    );

    it.each([
      { taskId: "" },
      { operationId: "" },
      { operationId: "../outside" },
    ])("requires a complete valid task binding %j", async (override) => {
      await expect(
        runPiHarnessOperation(options, { ...binding, ...override }),
      ).rejects.toThrow("Invalid Pi task operation binding");
      expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it("prepares a host-issued operation and does not expose runtime credentials", async () => {
      mocks.output = events({ type: "prepared", operationId: "operation-1" });
      await expect(
        preparePiHarnessOperation(
          { ...options, nativeApprovalUrl: "https://approval.test" },
          "context",
        ),
      ).resolves.toBe("operation-1");
    });

    it.each(["completed", "declined", "aborted", "failed"] as const)(
      "returns host terminal state %s without coercing it to success",
      async (status) => {
        mocks.output = events({
          type: "result",
          status,
          text: "Final private-runtime-token",
          operationId: "operation",
        });
        const result = await runPiHarnessOperation(options, binding);
        expect(result).toEqual({
          status,
          text: expect.stringContaining("Final"),
          operationId: "operation",
        });
        expect(result.text).not.toContain(options.runtimeAccessToken);
      },
    );

    it("delivers validated text, activity, usage and context updates before the final result", async () => {
      mocks.output = `${events(
        { type: "text_delta", delta: "Working" },
        {
          type: "activity",
          activity: {
            type: "tool",
            status: "completed",
            toolCallId: "call",
            toolName: "read",
            output: "ok",
          },
        },
        {
          type: "usage",
          usage: {
            inputTokens: 4,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
        {
          type: "context_usage",
          usage: {
            usedTokens: 6,
            maxTokens: 10000,
            modelName: "model-1",
            estimated: false,
          },
        },
        { type: "result", status: "completed", text: "Done" },
      )}\n`;
      const onTextDelta = vi.fn();
      const onActivity = vi.fn();
      const onUsage = vi.fn();
      const onContextUsage = vi.fn();
      await expect(
        runPiHarnessOperation(
          { ...options, onTextDelta, onActivity, onUsage, onContextUsage },
          binding,
        ),
      ).resolves.toEqual({ status: "completed", text: "Done" });
      expect(onTextDelta).toHaveBeenCalledWith("Working");
      expect(onActivity).toHaveBeenCalledWith(
        expect.objectContaining({ toolCallId: "call", status: "completed" }),
      );
      expect(onUsage).toHaveBeenCalledWith({
        inputTokens: 4,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      expect(onContextUsage).toHaveBeenCalledWith({
        usedTokens: 6,
        maxTokens: 10000,
        modelName: "model-1",
        estimated: false,
      });
    });

    it.each([
      ["not-json", "invalid host JSON"],
      ["null", "invalid host event"],
      [events({ type: "text_delta", delta: 4 }), "invalid text delta"],
      [events({ type: "activity" }), "invalid activity"],
      [
        events({
          type: "activity",
          activity: { type: "unknown", status: "running" },
        }),
        "invalid activity",
      ],
      [
        events({
          type: "activity",
          activity: { type: "tool", status: "unknown" },
        }),
        "invalid activity",
      ],
      [events({ type: "usage", usage: { inputTokens: -1 } }), "invalid usage"],
      [events({ type: "context_usage", usage: {} }), "invalid context usage"],
      [
        events({ type: "result", status: "unknown", text: "bad" }),
        "invalid terminal result",
      ],
      [
        events({ type: "result", status: "completed", text: 1 }),
        "invalid terminal result",
      ],
      [
        events(
          { type: "result", status: "completed", text: "one" },
          { type: "result", status: "completed", text: "two" },
        ),
        "invalid terminal result",
      ],
      [
        events({ type: "prepared", operationId: "operation" }),
        "invalid prepared operation",
      ],
      [
        events({ type: "error", code: 1, message: "bad" }),
        "invalid host error",
      ],
      [
        events({ type: "error", code: "FAIL", message: null }),
        "invalid host error",
      ],
      [events({ type: "unrecognized" }), "unknown host event"],
      ["\n\n", "without an operation result"],
    ])("fails closed on invalid host response %s", async (output, error) => {
      mocks.output = output;
      await expect(runPiHarnessOperation(options, binding)).rejects.toThrow(
        error,
      );
    });

    it.each([
      events({ type: "prepared", operationId: "../escape" }),
      events({ type: "prepared", operationId: 3 }),
      events(
        { type: "prepared", operationId: "operation" },
        { type: "prepared", operationId: "again" },
      ),
      events({ type: "result", status: "completed", text: "bad" }),
    ])("refuses invalid preparation result %s", async (output) => {
      mocks.output = output;
      await expect(
        preparePiHarnessOperation(options, "context"),
      ).rejects.toThrow("PI_PROTOCOL_ERROR");
    });

    it("preserves structured host failure codes with redacted messages", async () => {
      mocks.output = events({
        type: "error",
        code: "PI_SESSION_MISSING",
        message: "private-runtime-token missing",
      });
      const failure = await runPiHarnessOperation(options, binding).catch(
        (error: Error & { code: string }) => error,
      );
      expect(failure).toMatchObject({
        code: "PI_SESSION_MISSING",
        message: expect.stringContaining("missing"),
      });
      expect((failure as Error).message).not.toContain(
        options.runtimeAccessToken,
      );
    });

    it("allows cancellation after the caller signal has aborted", async () => {
      mocks.output = events({
        type: "result",
        status: "aborted",
        text: "Stopped",
      });
      const signal = AbortSignal.abort();
      await expect(
        cancelPiHarnessOperation(
          { ...options, signal, a2aContextId: binding.contextId },
          binding,
        ),
      ).resolves.toEqual({ status: "aborted", text: "Stopped" });
    });

    it("compacts the existing harness session and returns its terminal state", async () => {
      mocks.output = events({
        type: "result",
        status: "completed",
        text: "Compacted",
      });
      await expect(
        compactPiHarnessSession(options, "context", "Keep decisions"),
      ).resolves.toEqual({ status: "completed", text: "Compacted" });
      expect(
        mocks.writes.some(
          (text) =>
            text.includes('"sessionRequired":true') &&
            text.includes('"customInstructions":"Keep decisions"'),
        ),
      ).toBe(true);
    });
  });
});
