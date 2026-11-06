// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createAgentRuntimeToken,
  verifyAgentRuntimeToken,
} from "@/lib/agents/runtime-access";
import {
  sandboxExecutionBusy,
  withSandboxExecutionLease,
  serializeSandboxStep,
  withSandboxSessionLease,
} from "@/lib/agents/sandbox-execution-gate";

describe("native A2A execution credentials and sandbox serialization", () => {
  it("signs both task ID and lease, and rejects incomplete task authority", async () => {
    process.env.AUTH_SECRET = "test-only-native-task-token-secret";
    const payload = {
      workspaceId: "ws",
      agentId: "agent",
      agentRevisionId: "agent-revision-1",
      sandboxId: "sandbox",
      conversationId: "conversation",
      a2aContextId: "context",
      providerId: "provider",
      deploymentIds: [],
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const token = await createAgentRuntimeToken({
      ...payload,
      a2aTaskId: "task",
      a2aLeaseToken: "lease",
    });
    expect(await verifyAgentRuntimeToken(token)).toMatchObject({
      agentRevisionId: payload.agentRevisionId,
      a2aTaskId: "task",
      a2aLeaseToken: "lease",
      conversationId: "conversation",
      a2aContextId: "context",
    });
    await expect(
      createAgentRuntimeToken({ ...payload, a2aTaskId: "task" }),
    ).rejects.toThrow();
    await expect(
      createAgentRuntimeToken({ ...payload, a2aLeaseToken: "lease" }),
    ).rejects.toThrow();
    expect(
      await verifyAgentRuntimeToken(`${token.slice(0, -3)}bad`),
    ).toBeNull();
  });
  it("reserves one sandbox, permits nested runtime dispatch and always releases the lease", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withSandboxExecutionLease("sandbox", async () => {
      await withSandboxExecutionLease("sandbox", async () => undefined);
      await blocked;
    });
    expect(() =>
      withSandboxExecutionLease("sandbox", async () => undefined),
    ).toThrow();
    await withSandboxExecutionLease("other-sandbox", async () => undefined);
    release();
    await first;
    await expect(
      withSandboxExecutionLease("sandbox", async () => {
        throw new Error("fixture");
      }),
    ).rejects.toThrow();
    await withSandboxExecutionLease("sandbox", async () => undefined);
  });
  it("runs different sessions of one sandbox concurrently but keeps each session and maintenance exclusive", async () => {
    const { promise: blocked, resolve: release } =
      Promise.withResolvers<void>();
    const first = withSandboxSessionLease("shared", "conversation-a", () =>
      withSandboxSessionLease("shared", "conversation-a", () => blocked),
    );
    const second = withSandboxSessionLease("shared", "conversation-b", () =>
      withSandboxSessionLease("shared", "conversation-b", () => blocked),
    );
    expect(() =>
      withSandboxSessionLease(
        "shared",
        "conversation-a",
        async () => undefined,
      ),
    ).toThrow();
    expect(() =>
      withSandboxExecutionLease("shared", async () => undefined),
    ).toThrow();
    release();
    await Promise.all([first, second]);
    expect(sandboxExecutionBusy("shared")).toBe(false);

    const { promise: held, resolve: finish } = Promise.withResolvers<void>();
    const upgraded = withSandboxSessionLease("shared", "conversation-a", () =>
      withSandboxExecutionLease("shared", () => held),
    );
    expect(() =>
      withSandboxSessionLease(
        "shared",
        "conversation-b",
        async () => undefined,
      ),
    ).toThrow();
    finish();
    await upgraded;
    await withSandboxExecutionLease("shared", () =>
      withSandboxSessionLease(
        "shared",
        "conversation-b",
        async () => undefined,
      ),
    );
    expect(sandboxExecutionBusy("shared")).toBe(false);
  });
  it("runs per-sandbox steps in order and keeps the queue after a failure", async () => {
    const order: string[] = [];
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    const first = serializeSandboxStep("runtime:shared", async () => {
      await gate;
      order.push("first");
      throw new Error("install failed");
    });
    const second = serializeSandboxStep("runtime:shared", async () => {
      order.push("second");
    });
    const other = serializeSandboxStep("runtime:other", async () => {
      order.push("other");
    });
    await other;
    expect(order).toEqual(["other"]);
    open();
    await expect(first).rejects.toThrow("install failed");
    await second;
    expect(order).toEqual(["other", "first", "second"]);
  });
});
