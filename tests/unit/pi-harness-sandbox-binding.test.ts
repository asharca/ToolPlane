import { assertDefined } from "../assert-defined";
import { EventEmitter } from "node:events";
import type * as FsPromises from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  events: [] as unknown[],
  exitCode: 0,
  executions: [] as string[][],
}));
vi.mock("@/lib/db", () => ({
  db: {
    agentSandbox: {
      findUnique: vi.fn(async () => ({
        agent: { workspaceId: "workspace" },
        sandbox: {
          workspaceId: "workspace",
          kind: "docker",
          network: "bridge",
          deploymentId: "sandbox-deployment",
          deployment: { status: "running" },
        },
      })),
    },
  },
}));
vi.mock("@/lib/process/supervisor", () => ({
  effectiveStatus: () => "running",
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof FsPromises>();
  const readFile = vi.fn(
    async () => "// fixture host source; not executed by fake Docker",
  );
  return { ...actual, default: { ...actual, readFile }, readFile };
});
vi.mock("node:child_process", async (original) => {
  const actual = await original<Record<string, unknown>>();
  const spawn = vi.fn((_command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: EventEmitter & { end: (input: unknown) => void };
      kill: () => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    child.stdin = Object.assign(new EventEmitter(), {
      end(input: unknown) {
        const writeIndex = args.indexOf("toolplane-write");
        if (writeIndex >= 0)
          state.files.set(args[writeIndex + 1], String(input));
      },
    });
    state.executions.push(args);
    setImmediate(() => {
      const wrapper = args.find((arg) =>
        arg.includes("__TOOLPLANE_RUNTIME_PID_"),
      );
      const prefix = wrapper?.match(/__TOOLPLANE_RUNTIME_PID_[^_]+__/)?.[0];
      if (prefix) child.stdout.emit("data", Buffer.from(`${prefix}43210\n`));
      const command = args.slice(args.indexOf("toolplane-runtime") + 2);
      const host =
        command[0] === "node" &&
        command[1]?.endsWith("/pi-harness-session.mjs");
      if (host)
        child.stdout.emit(
          "data",
          Buffer.from(
            state.events.map((event) => JSON.stringify(event)).join("\n"),
          ),
        );
      const code = host ? state.exitCode : 0;
      child.emit("exit", code, null);
      child.emit("close", code, null);
    });
    return child;
  });
  return { ...actual, default: { ...actual, spawn }, spawn };
});

import {
  cancelPiHarnessOperation,
  preparePiHarnessOperation,
  runPiHarnessOperation,
  type RunSandboxAgentTurnOptions,
} from "@/lib/agents/sandbox-runtime";
import { PiRuntimeInterruptedError } from "@/lib/agents/pi-harness";

const options: RunSandboxAgentTurnOptions = {
  runtimeKind: "pi",
  workspaceId: "workspace",
  agentId: "agent",
  sandboxId: "sandbox",
  provider: { id: "provider", name: "Provider", format: "openai" },
  modelId: "model",
  contextWindow: 32000,
  modelProxyBase: "http://proxy.test/v1",
  runtimeAccessToken: "private-runtime-token",
  messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
  piHarness: {
    historyRequired: true,
    communicationEnabled: true,
    thinkingLevel: "low",
  },
};
const binding = {
  taskId: "task",
  contextId: "context",
  operationId: "operation",
};

beforeEach(() => {
  state.files.clear();
  state.events = [];
  state.exitCode = 0;
  state.executions = [];
});

describe("Pi Harness sandbox binding", () => {
  it("prepares only an operation and projects the isolated host configuration", async () => {
    state.events = [{ type: "prepared", operationId: "operation" }];
    expect(await preparePiHarnessOperation(options, "context")).toBe(
      "operation",
    );
    const entry = assertDefined(
      [...state.files].find(([path]) => path.endsWith("-pi-harness.json")),
    );
    const config = JSON.parse(entry[1]);
    expect(config).toMatchObject({
      action: "prepare",
      contextId: "context",
      providerId: "toolplane",
      directory: "/workspace/.toolplane/runtimes/pi/agents/agent/harness",
      historyRequired: true,
      communicationEnabled: true,
      thinkingLevel: "low",
      legacyStatePath:
        "/workspace/.toolplane/runtimes/pi/agents/agent/sessions/context.json",
    });
    expect(config.operationId).toBeUndefined();
    expect(
      JSON.parse(assertDefined(state.files.get(config.modelsPath))).providers
        .toolplane.models[0].contextWindow,
    ).toBe(32000);
    expect(
      state.executions.some((args) =>
        args.some((arg) =>
          arg.includes("/pi-harness-0.87.1/pi-harness-session.mjs"),
        ),
      ),
    ).toBe(true);
  });

  it("preserves coded host errors even when Docker exits unsuccessfully", async () => {
    state.events = [
      {
        type: "error",
        code: "PI_SESSION_CORRUPT",
        message: "Cannot open private-runtime-token",
      },
    ];
    state.exitCode = 137;
    await expect(runPiHarnessOperation(options, binding)).rejects.toMatchObject(
      {
        code: "PI_SESSION_CORRUPT",
        message: "PI_SESSION_CORRUPT: Cannot open [REDACTED]",
      },
    );
  });

  it("rejects unknown terminal statuses instead of reporting success", async () => {
    state.events = [{ type: "result", status: "working", text: "" }];
    await expect(runPiHarnessOperation(options, binding)).rejects.toThrow(
      "PI_PROTOCOL_ERROR: invalid terminal result",
    );
  });

  it("classifies killed drivers without host errors as interrupted", async () => {
    state.exitCode = 137;
    await expect(
      runPiHarnessOperation(options, binding),
    ).rejects.toBeInstanceOf(PiRuntimeInterruptedError);
  });

  it("cancels with a fresh exec despite the caller signal, preserving an already completed result", async () => {
    state.events = [
      {
        type: "result",
        status: "completed",
        text: "done private-runtime-token",
      },
    ];
    const controller = new AbortController();
    controller.abort();
    expect(
      await cancelPiHarnessOperation(
        { ...options, signal: controller.signal },
        binding,
      ),
    ).toEqual({ status: "completed", text: "done [REDACTED]" });
    const config = JSON.parse(
      assertDefined(
        [...state.files].find(([path]) => path.endsWith("-pi-harness.json")),
      )[1],
    );
    expect(config).toMatchObject({ action: "cancel", ...binding });
  });
});
