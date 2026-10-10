// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { Task } from "@a2a-js/sdk";
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/runtime/ownership-state", () => ({
  assertRuntimeOwner: vi.fn(),
}));
vi.mock("@/lib/observability/a2a-log", () => ({
  recordA2AEvent: vi.fn(),
  a2aTaskOutcome: vi.fn(),
  taskStateName: vi.fn(),
}));
vi.mock("@/lib/a2a/local-policy", () => ({
  createLocalEntryGrant: vi.fn(),
  assertLocalGrant: vi.fn(),
  localOwnerKey: vi.fn(),
}));
vi.mock("@/lib/a2a/entry-policy", () => ({ createEntryPolicy: vi.fn() }));
vi.mock("@/lib/a2a/store", () => ({
  submitTaskInTransaction: vi.fn(),
  getTaskRow: vi.fn(),
  requestCancellation: vi.fn(),
  taskScope: vi.fn(),
}));
vi.mock("@/lib/a2a/quotas", () => ({ refreshTaskStorage: vi.fn() }));
vi.mock("@/lib/a2a/worker", () => ({ wakeA2AWorker: vi.fn() }));
import { nativeEntryRuntimeParts } from "@/lib/a2a/ingress";
import {
  COMMAND_RESULT_PART,
  RUNTIME_COMMANDS_PART,
  RUNTIME_USAGE_PART,
  sessionRuntimeCommands,
} from "@/lib/agents/runtime-commands";
const commands = [{ name: "Review:1", description: "Review current branch" }];
const usage = {
  inputTokens: 3,
  outputTokens: 5,
  cacheReadTokens: 7,
  cacheWriteTokens: 0,
  costUsd: 0.01,
};
const commandResult = {
  command: "Review:1",
  text: "Command completed.",
  status: "completed",
};
function task(metadata: unknown, state = "TASK_STATE_COMPLETED") {
  return Task.fromJSON({
    id: "task",
    status: { state },
    artifacts: [
      {
        artifactId: "result",
        parts: [{ text: "Command completed." }],
        metadata: { toolplanePiSdk: metadata },
      },
    ],
  });
}
describe("native SDK presentation metadata", () => {
  it("survives durable ProtoJSON and conversation history without losing command case or suffix", () => {
    const original = task({ commands, usage, commandResult });
    const restored = Task.fromJSON(
      JSON.parse(JSON.stringify(Task.toJSON(original))),
    );
    const parts = nativeEntryRuntimeParts(restored);
    expect(parts).toEqual([
      {
        type: RUNTIME_COMMANDS_PART,
        data: { runtimeKind: "pi-sdk", commands },
      },
      { type: RUNTIME_USAGE_PART, data: usage },
      { type: COMMAND_RESULT_PART, data: commandResult },
    ]);
    expect(sessionRuntimeCommands("pi-sdk", [{ parts }])).toContainEqual(
      commands[0],
    );
    expect(Task.toJSON(restored)).toEqual(Task.toJSON(original));
  });
  it.each([
    { commands, sessionFile: "/private/session.jsonl" },
    { commands, usage: { ...usage, runtimeToken: "private-token" } },
    { commands, usage: { ...usage, inputTokens: -1 } },
    { commands, commandResult: { ...commandResult, contextId: "/private" } },
    { commands, commandResult: { ...commandResult, status: "unknown" } },
    { commands: [{ name: "../escape" }] },
    { commands: [{ name: "Review", execute: "private-code" }] },
    { commands: Array.from({ length: 201 }, () => ({ name: "Review" })) },
    { commands, commandResult: { ...commandResult, text: "x".repeat(65537) } },
  ])("does not project malformed or private metadata %j", (metadata) => {
    expect(nativeEntryRuntimeParts(task(metadata))).toEqual([]);
  });
  it("does not turn failed tasks or non-text artifacts into successful command history", () => {
    expect(
      nativeEntryRuntimeParts(task({ commands }, "TASK_STATE_FAILED")),
    ).toEqual([]);
    const binary = task({ commands });
    binary.artifacts[0].parts = [];
    expect(nativeEntryRuntimeParts(binary)).toEqual([]);
    expect(
      nativeEntryRuntimeParts(
        Task.fromJSON({
          id: "old",
          status: { state: "TASK_STATE_COMPLETED" },
          artifacts: [{ parts: [{ text: "Old Pi output" }] }],
        }),
      ),
    ).toEqual([]);
  });
});
