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
  cancelPiHarnessOperation,
} from "@/lib/agents/sandbox-runtime";

const options: RunSandboxAgentTurnOptions = {
  runtimeKind: "pi-sdk",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  sandboxId: "sandbox-1",
  provider: { id: "provider-1", name: "Provider", format: "openai" },
  modelId: "model-1",
  runtimeSessionId: "session-1",
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
        commandArgs.some(
          (arg) => arg.endsWith("-session.mjs") || arg.endsWith("-drain.mjs"),
        );
      queueMicrotask(() => {
        if (commandArgs.includes("toolplane-write")) mocks.writes.push(stdin);
        const output = turn ? mocks.output : "";
        const control = args
          .join(" ")
          .match(/__TOOLPLANE_RUNTIME_PID_[a-f0-9-]+__/u)?.[0];
        if (control) child.stdout.write(`${control}123\n`);
        if (output) child.stdout.write(output);
        if (turn && mocks.failure) child.stderr.write(mocks.failure);
        const code = turn && mocks.failure ? 1 : 0;
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
      {
        type: "toolplane_sdk_response",
        success: true,
        result: { text: "Answer private-runtime-token" },
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

  it("uses SDK terminal text when no text deltas arrived", async () => {
    mocks.output = events({
      type: "toolplane_sdk_response",
      success: true,
      result: { text: "Final answer" },
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
  });

  it.each(["pi", "claude-code", "dsh"] as const)(
    "rejects retired %s execution before accessing the sandbox",
    async (runtimeKind) => {
      await expect(
        runSandboxAgentTurn({ ...options, runtimeKind }),
      ).rejects.toThrow("AGENT_RUNTIME_RETIRED");
      expect(mocks.findSandbox).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it("does not treat partial SDK output as success after a provider failure", async () => {
    mocks.output = events(
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Partial" },
      },
      {
        type: "toolplane_sdk_response",
        success: false,
        error: { code: "PI_SDK_FAILED" },
      },
    );
    await expect(runSandboxAgentTurn(options)).rejects.toThrow("PI_SDK_FAILED");
  });

  it("supports native session command results without requiring a new user prompt", async () => {
    mocks.output = events({
      type: "toolplane_sdk_response",
      success: true,
      result: {
        text: "Compacted",
        commandResult: {
          command: "compact",
          text: "Compacted",
          status: "completed",
        },
      },
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

  it("keeps stderr errors bounded to the turn and redacts the runtime token", async () => {
    mocks.failure = "provider private-runtime-token unavailable";
    await expect(runSandboxAgentTurn(options)).rejects.toThrow("unavailable");
    const error = await runSandboxAgentTurn(options).catch(
      (value: Error) => value,
    );
    expect((error as Error).message).not.toContain(options.runtimeAccessToken);
    expect((error as Error).stack).not.toContain(options.runtimeAccessToken);
    expect((error as Error).cause).toBeUndefined();
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

  describe("historical Pi harness drain", () => {
    const binding = {
      contextId: "context",
      operationId: "operation",
      taskId: "task",
    };
    const drainOptions = {
      workspaceId: options.workspaceId,
      agentId: options.agentId,
      sandboxId: options.sandboxId,
      a2aContextId: binding.contextId,
    };

    it.each(["completed", "declined", "aborted", "failed"] as const)(
      "drains an existing operation without coercing %s to success",
      async (status) => {
        mocks.output = events({
          status,
          text: "Stopped",
          operationId: "operation",
        });
        await expect(
          cancelPiHarnessOperation(drainOptions, binding),
        ).resolves.toEqual({
          status,
          text: "Stopped",
          operationId: "operation",
        });
        expect(
          mocks.spawn.mock.calls.some(([, args]) =>
            args.includes("toolplane-pnpm-install"),
          ),
        ).toBe(false);
        expect(
          mocks.writes.some((text) => text.includes('"taskId":"task"')),
        ).toBe(true);
      },
    );

    it.each([{ a2aContextId: "foreign" }, { agentId: "foreign" }])(
      "rejects a changed historical binding %j before spawning",
      async (override) => {
        await expect(
          cancelPiHarnessOperation({ ...drainOptions, ...override }, binding),
        ).rejects.toThrow("binding changed");
        expect(mocks.spawn).not.toHaveBeenCalled();
      },
    );

    it("rejects an unsafe operation identity before spawning", async () => {
      await expect(
        cancelPiHarnessOperation(drainOptions, {
          ...binding,
          operationId: "../escape",
        }),
      ).rejects.toThrow("binding changed");
      expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it("fails closed when drain output has no terminal state", async () => {
      await expect(
        cancelPiHarnessOperation(drainOptions, binding),
      ).rejects.toThrow("PI_PROTOCOL_ERROR");
    });

    it("rejects malformed terminal drain state", async () => {
      mocks.output = events({ status: "unknown", text: "Stopped" });
      await expect(
        cancelPiHarnessOperation(drainOptions, binding),
      ).rejects.toThrow();
    });
  });
});
