// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { A2ATask } from "@prisma/client";

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
import { executePublishedTask, executeTask } from "@/lib/a2a/executor";

const history = {
  id: "retained-task",
  contextId: "retained-context",
  grant: {
    kind: "published",
    workspaceId: "workspace",
    ownerKey: "owner",
    endpointId: "endpoint",
    clientId: "revoked-client",
  },
  snapshot: {
    id: "retained-task",
    contextId: "retained-context",
    status: { state: "TASK_STATE_COMPLETED" },
    history: [
      {
        messageId: "old-message",
        role: "ROLE_USER",
        parts: [{ text: "Retained history" }],
      },
    ],
  },
} as unknown as A2ATask;

beforeEach(() => vi.clearAllMocks());

describe("retired published execution boundary", () => {
  it.each([executePublishedTask, executeTask])(
    "rejects retained published tasks without provisioning, locks, or dispatch",
    async (execute) => {
      const retained = structuredClone(history.snapshot);
      await expect(
        execute(history, new AbortController().signal),
      ).rejects.toMatchObject({ status: 410 });
      expect(history.snapshot).toEqual(retained);
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );

  it("does not resume legacy published work even with an allocation recorded in history", async () => {
    const allocated = {
      ...history,
      nativeOperationId: "old-operation",
      runtimeAllocationId: "old-allocation",
    };
    await expect(
      executeTask(allocated, new AbortController().signal),
    ).rejects.toMatchObject({ status: 410 });
  });
});
