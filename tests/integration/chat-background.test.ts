// @vitest-environment node
import { assertDefined } from "../assert-defined";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  beginChatTurn,
  createChatAssistant,
  createChatThread,
  deleteChatAssistant,
  deleteChatThread,
  finishChatTurn,
} from "@/lib/chat/service";
import { db } from "@/lib/db";
import { createApiToken } from "@/lib/auth/tokens";
import { POST, DELETE } from "@/app/api/v1/chat/threads/[threadId]/turns/route";
import { GET } from "@/app/api/v1/chat/threads/[threadId]/turns/stream/route";
import { GET as GET_STATUS } from "@/app/api/v1/chat/assistants/route";
import { POST as CONFIRM } from "@/app/api/v1/chat/threads/[threadId]/turns/confirmations/route";
import {
  appendChatRunEvent,
  getChatRunSnapshot,
  recoverStaleChatRuns,
  subscribeChatRun,
} from "@/lib/chat/run-control";
import { wrapChatTools } from "@/lib/chat/durable-tools";
import { jsonSchema } from "@/lib/agents/agent-tool";
import { McpToolNotDispatchedError } from "@/lib/remote-mcp/pinned-connection";
import { buildToolSet, toolKey } from "@/lib/agents/tools";
import { loadMcpToolPolicies } from "@/lib/workspace/mcp-tool-exposure";
import {
  chatProviderFixture,
  type ChatProviderFixture,
} from "../fixtures/chat-provider";

let provider: ChatProviderFixture;
let userId: string,
  otherId: string,
  workspaceId: string,
  assistantId: string,
  revisionId: string;
let token: string, otherToken: string;
// Real sockets and PostgreSQL commit outside fake timers; await observed state, not a fixed sleep.
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 12_000;
  while (!(await check())) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for persisted chat state");
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 25);
    await tick.promise;
  }
}
async function thread() {
  return db.chatThread.create({
    data: {
      workspaceId,
      assistantId,
      assistantRevisionId: revisionId,
      legacyRevisionUnresolved: false,
    },
  });
}
async function leasedRun() {
  const chat = await thread();
  const fence = { leaseToken: randomUUID(), generation: 1 };
  const turn = await db.chatTurn.create({
    data: {
      threadId: chat.id,
      actorUserId: userId,
      ...fence,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  const message = await db.chatMessage.create({
    data: {
      threadId: chat.id,
      turnId: turn.id,
      role: "assistant",
      status: "pending",
      parts: [],
    },
  });
  return {
    scope: {
      threadId: chat.id,
      turnId: turn.id,
      assistantMessageId: message.id,
      userId,
      workspaceId,
    },
    fence,
  };
}
function request(
  id: string,
  method: string,
  body?: unknown,
  credential = token,
  signal?: AbortSignal,
) {
  return new Request(`http://localhost/api/v1/chat/threads/${id}/turns`, {
    method,
    signal,
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ threadId: id }) });
async function start(id: string, signal?: AbortSignal) {
  const response = await POST(
    request(
      id,
      "POST",
      {
        idempotencyKey: randomUUID(),
        messages: [
          {
            id: randomUUID(),
            role: "user",
            parts: [{ type: "text", text: "Continue on the server" }],
          },
        ],
      },
      token,
      signal,
    ),
    params(id),
  );
  expect(response.status).toBe(200);
  return response;
}

async function deletionFixture() {
  const source = await db.chatAssistant.findUniqueOrThrow({
    where: { id: assistantId },
  });
  const assistant = await createChatAssistant(userId, {
    workspaceId,
    name: "Deletion safety fixture",
    modelProviderId: source.modelProviderId,
    model: source.model,
    mcpGrants: [],
  });
  const chat = await createChatThread(userId, assistant.id, {});
  return { assistant, chat };
}

async function waitForBlockedTransactions(
  blockerPid: number,
  expected: number,
) {
  await until(async () => {
    // Include waiters queued behind another waiter, not only the direct blocker.
    const rows = await db.$queryRaw<Array<{ waiting: bigint }>>(Prisma.sql`
      WITH RECURSIVE blocked(pid) AS (
        SELECT pid FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
        UNION
        SELECT activity.pid FROM pg_stat_activity activity
        JOIN blocked parent ON parent.pid = ANY(pg_blocking_pids(activity.pid))
      ) SELECT count(*) AS waiting FROM blocked
    `);
    return Number(rows[0]?.waiting ?? 0) >= expected;
  });
}

beforeAll(async () => {
  const stamp = randomUUID();
  provider = await chatProviderFixture();
  userId = (
    await db.user.create({
      data: {
        email: `chat-background-${stamp}@test.invalid`,
        passwordHash: "fixture",
      },
    })
  ).id;
  otherId = (
    await db.user.create({
      data: {
        email: `chat-background-other-${stamp}@test.invalid`,
        passwordHash: "fixture",
      },
    })
  ).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        name: "Chat background fixture",
        slug: `chat-background-${stamp}`,
        ownerId: userId,
      },
    })
  ).id;
  const model = await db.modelProvider.create({
    data: {
      workspaceId,
      name: "Local controlled provider",
      format: "openai",
      baseUrl: `${provider.baseUrl}/v1`,
      apiKey: "local-fixture-only",
      models: ["chat-background-fixture"],
    },
  });
  assistantId = (
    await db.chatAssistant.create({
      data: {
        workspaceId,
        name: "Background fixture",
        modelProviderId: model.id,
        model: "chat-background-fixture",
      },
    })
  ).id;
  revisionId = (
    await db.chatAssistantRevision.create({
      data: {
        assistantId,
        version: 1,
        config: {
          schemaVersion: 1,
          systemPrompt: null,
          modelProviderId: model.id,
          model: "chat-background-fixture",
          modelParameters: null,
          maxSteps: 5,
          mcpGrants: [],
        },
      },
    })
  ).id;
  await db.chatAssistant.update({
    where: { id: assistantId },
    data: { currentRevisionVersion: 1 },
  });
  token = (await createApiToken(userId, "Chat background test")).token;
  otherToken = (await createApiToken(otherId, "Outside workspace")).token;
});
afterAll(async () => {
  await provider?.close();
  if (workspaceId) {
    await until(
      async () =>
        (await db.chatTurn.count({
          where: { thread: { workspaceId }, status: "pending" },
        })) === 0,
    );
    await db.workspace.delete({ where: { id: workspaceId } });
  }
  await db.user.deleteMany({
    where: { id: { in: [userId, otherId].filter(Boolean) } },
  });
  await db.$disconnect();
});

describe("assistant background execution with real persistence", () => {
  it("continues without an observer, persists once, and can replay the same answer", async () => {
    const chat = await thread();
    const controller = new AbortController();
    const response = await start(chat.id, controller.signal);
    const turnId = assertDefined(response.headers.get("X-Chat-Turn-Id"));
    const reader = assertDefined(response.body).getReader();
    await reader.read();
    await until(async () => provider.state().pending === 1);
    const statusRequest = () =>
      new Request(
        `http://localhost/api/v1/chat/assistants?workspaceId=${workspaceId}&running=1`,
        { headers: { authorization: `Bearer ${token}` } },
      );
    expect(await (await GET_STATUS(statusRequest())).json()).toEqual({
      runningThreadIds: [chat.id],
    });
    expect(
      (
        await GET_STATUS(
          new Request(statusRequest(), {
            headers: { authorization: `Bearer ${otherToken}` },
          }),
        )
      ).status,
    ).toBe(404);
    controller.abort();
    await reader.cancel();
    const before = provider.state();
    provider.release();
    await until(
      async () =>
        (await db.chatTurn.findUniqueOrThrow({ where: { id: turnId } }))
          .status === "completed",
    );
    const answer = await db.chatMessage.findFirstOrThrow({
      where: { turnId, role: "assistant" },
    });
    expect(answer.status).toBe("success");
    expect(answer.parts).toEqual([
      expect.objectContaining({
        type: "text",
        text: "Before disconnect. Completed on server.",
      }),
    ]);
    const resumed = await GET(request(chat.id, "GET"), params(chat.id));
    expect(resumed.headers.get("X-Chat-Run-Id")).toBe(turnId);
    expect(resumed.headers.get("X-Chat-Cursor")).toBe("0");
    const replay = await resumed.text();
    expect(replay).toContain("Completed on server.");
    expect(replay).toContain("data-chat-cursor");
    const events = await db.chatRunEvent.findMany({
      where: { turnId },
      orderBy: { sequence: "asc" },
    });
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index + 1),
    );
    expect(events.at(-1)?.payload).toEqual(
      expect.objectContaining({ type: "finish" }),
    );
    const snapshot = assertDefined(
      await getChatRunSnapshot(chat.id, { userId, workspaceId, runId: turnId }),
    );
    expect(snapshot.cursor).toBe(events.length);
    expect(snapshot.status).toBe("completed");
    expect(provider.state().calls).toBe(before.calls);
    expect(provider.state().aborted).toBe(before.aborted);
    expect(
      await db.chatMessage.count({ where: { turnId, role: "assistant" } }),
    ).toBe(1);
    expect(await (await GET_STATUS(statusRequest())).json()).toEqual({
      runningThreadIds: [],
    });
  });

  it("denies cross-workspace replay and stop, but the owner can explicitly stop", async () => {
    const chat = await thread();
    const response = await start(chat.id);
    const turnId = assertDefined(response.headers.get("X-Chat-Turn-Id"));
    await until(async () => provider.state().pending === 1);
    expect(
      (
        await GET(
          request(chat.id, "GET", undefined, otherToken),
          params(chat.id),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await DELETE(
          request(chat.id, "DELETE", { turnId }, otherToken),
          params(chat.id),
        )
      ).status,
    ).toBe(404);
    const duplicate = await POST(
      request(chat.id, "POST", {
        idempotencyKey: randomUUID(),
        messages: [
          {
            id: "duplicate",
            role: "user",
            parts: [{ type: "text", text: "Do not execute" }],
          },
        ],
      }),
      params(chat.id),
    );
    expect(duplicate.status).toBe(409);
    const aborted = provider.state().aborted;
    expect(
      await (
        await DELETE(request(chat.id, "DELETE", { turnId }), params(chat.id))
      ).json(),
    ).toEqual({ stopRequested: true, turnId });
    await response.text();
    await until(async () => provider.state().aborted === aborted + 1);
    await until(
      async () =>
        (await db.chatTurn.findUniqueOrThrow({ where: { id: turnId } }))
          .status === "cancelled",
    );
    expect(
      (await db.chatTurn.findUniqueOrThrow({ where: { id: turnId } })).status,
    ).toBe("cancelled");
    expect(
      (
        await db.chatMessage.findFirstOrThrow({
          where: { turnId, role: "assistant" },
        })
      ).parts,
    ).toEqual([
      expect.objectContaining({ type: "text", text: "Before disconnect. " }),
    ]);
  });

  it("stops detached execution when the workspace is suspended", async () => {
    const chat = await thread();
    const response = await start(chat.id);
    const turnId = assertDefined(response.headers.get("X-Chat-Turn-Id"));
    await until(async () => provider.state().pending === 1);
    await assertDefined(response.body).cancel();
    await db.workspace.update({
      where: { id: workspaceId },
      data: { status: "suspended" },
    });
    try {
      await until(
        async () =>
          (await db.chatTurn.findUniqueOrThrow({ where: { id: turnId } }))
            .status === "failed",
      );
      expect((await GET(request(chat.id, "GET"), params(chat.id))).status).toBe(
        404,
      );
      await until(async () => provider.state().pending === 0);
    } finally {
      await db.workspace.update({
        where: { id: workspaceId },
        data: { status: "active" },
      });
    }
  }, 15_000);
  it("recovers expired owners without provider replay and retains interrupted partial text", async () => {
    const { scope, fence } = await leasedRun();
    await appendChatRunEvent(scope, fence, {
      type: "text-delta",
      id: "partial",
      delta: "Retain this partial answer",
    });
    const confirmation = await db.chatToolConfirmation.create({
      data: {
        turnId: scope.turnId,
        toolCallId: "lost-effect",
        toolName: "mutate",
        input: {},
      },
    });
    await db.chatToolConfirmation.update({
      where: { id: confirmation.id },
      data: {
        status: "approved",
        approverUserId: userId,
        resolvedAt: new Date(),
      },
    });
    await db.chatToolConfirmation.update({
      where: { id: confirmation.id },
      data: { status: "executing", executionStartedAt: new Date() },
    });
    const calls = provider.state().calls;
    await db.chatTurn.update({
      where: { id: scope.turnId },
      data: { leaseExpiresAt: new Date(Date.now() - 1) },
    });
    await recoverStaleChatRuns(scope.threadId);
    const snapshot = assertDefined(
      await getChatRunSnapshot(scope.threadId, { userId, workspaceId }),
    );
    expect(snapshot.status).toBe("failed");
    expect(snapshot.phase).toBe("execution_unknown");
    expect(snapshot.confirmations[0].status).toBe("execution_unknown");
    expect(snapshot.messages[0].parts).toEqual([
      { type: "text", id: "partial", text: "Retain this partial answer" },
    ]);
    await expect(
      appendChatRunEvent(scope, fence, {
        type: "text-delta",
        id: "partial",
        delta: "stale write",
      }),
    ).rejects.toThrow("lease was lost");
    const replay = assertDefined(
      await subscribeChatRun(scope.threadId, null, {
        userId,
        workspaceId,
        runId: scope.turnId,
        afterSequence: 1,
      }),
    );
    const reader = replay.stream.getReader();
    const chunks = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    expect(chunks.some((chunk) => chunk.type === "text-delta")).toBe(false);
    expect(chunks.some((chunk) => chunk.type === "error")).toBe(true);
    expect(provider.state().calls).toBe(calls);
  });

  it("settles a proven pre-dispatch revocation after approval without an unknown effect or deletion blockade", async () => {
    const { scope, fence } = await leasedRun();
    const deployment = await db.deployment.create({
      data: {
        workspaceId,
        name: "Revocable effect fixture",
        source: "remote",
        sourceRef: "https://mcp.example.test/effects",
        installCfg: { transport: "streamable-http", authType: "none" },
        mcpToolExposure: "allowlist",
        mcpAllowedTools: ["mutate"],
      },
    });
    const grantKey = { assistantId, deploymentId: deployment.id };
    await db.chatAssistantMcpGrant.create({
      data: { ...grantKey, allowedToolNames: ["mutate"] },
    });
    let externalCalls = 0;
    let unknownOutcome: unknown;
    const tools = wrapChatTools(
      {
        mutate: {
          name: "mutate",
          description: "Exercise a transport-certified pre-dispatch refusal",
          parameters: jsonSchema({ type: "object", properties: {} }),
          execute: async () => {
            const live = await db.chatAssistantMcpGrant.findUnique({
              where: { assistantId_deploymentId: grantKey },
            });
            if (!live?.allowedToolNames.includes("mutate")) {
              throw new McpToolNotDispatchedError(
                new Error("Assistant MCP grant was revoked"),
              );
            }
            externalCalls += 1;
            return { content: [{ type: "text", text: "effect completed" }] };
          },
        },
      },
      {
        ...scope,
        fence,
        signal: new AbortController().signal,
        onUnknownOutcome: (error) => {
          unknownOutcome = error;
        },
      },
    );
    const outcome = tools.mutate
      .execute({}, { toolCallId: "revoked-effect" })
      .catch((error: unknown) => error);
    await until(
      async () =>
        (await db.chatToolConfirmation.count({
          where: { turnId: scope.turnId, status: "awaiting_user" },
        })) === 1,
    );
    const confirmation = await db.chatToolConfirmation.findFirstOrThrow({
      where: { turnId: scope.turnId },
    });
    await db.chatAssistantMcpGrant.delete({
      where: { assistantId_deploymentId: grantKey },
    });
    const decision = await CONFIRM(
      request(scope.threadId, "POST", {
        confirmationId: confirmation.id,
        approved: true,
      }),
      params(scope.threadId),
    );
    expect(decision.status).toBe(200);
    expect(await outcome).toBeInstanceOf(McpToolNotDispatchedError);
    expect(externalCalls).toBe(0);
    expect(unknownOutcome).toBeUndefined();
    expect(
      await db.chatToolConfirmation.findUniqueOrThrow({
        where: { id: confirmation.id },
      }),
    ).toMatchObject({
      status: "failed",
      error: "Assistant MCP grant was revoked",
      executionCompletedAt: expect.any(Date),
    });
    expect(
      await db.chatRunEvent.findFirst({
        where: {
          turnId: scope.turnId,
          payload: { path: ["data", "phase"], equals: "failed" },
        },
      }),
    ).not.toBeNull();
    await finishChatTurn(
      scope.threadId,
      scope.turnId,
      "failed",
      "Tool authority revoked",
      scope.assistantMessageId,
      [],
      fence,
    );
    await deleteChatThread(userId, scope.threadId);
    expect(
      await db.chatThread.findUnique({ where: { id: scope.threadId } }),
    ).toBeNull();
  });

  it("fails a confirmed tool when deployment exposure narrows during approval without dispatch or unknown effect", async () => {
    const { scope, fence } = await leasedRun();
    const deployment = await db.deployment.create({
      data: {
        workspaceId,
        name: "Approval exposure revocation fixture",
        source: "remote",
        sourceRef: "https://mcp.example.test/approved-effect",
        installCfg: { transport: "streamable-http", authType: "none" },
        mcpToolExposure: "allowlist",
        mcpAllowedTools: ["mutate"],
      },
    });
    let externalCalls = 0;
    let unknownOutcome: unknown;
    const offered = await buildToolSet([deployment.id], workspaceId, {
      liveStatus: () => "stopped",
      requireRunning: false,
      loadMcpToolPolicies,
      listMcpTools: async () => [
        { name: "mutate", inputSchema: { type: "object", properties: {} } },
      ],
      mcpRpc: async () => {
        externalCalls += 1;
        return { content: [{ type: "text", text: "effect completed" }] };
      },
      logRequest: async () => undefined,
      onToolExposureDenied: (_deploymentId, toolName) => {
        throw new McpToolNotDispatchedError(
          new Error(`MCP tool ${toolName} is not exposed to AI.`),
        );
      },
    });
    const key = toolKey(deployment.id, "mutate");
    expect(offered[key]).toBeDefined();
    const tools = wrapChatTools(offered, {
      ...scope,
      fence,
      signal: new AbortController().signal,
      onUnknownOutcome: (error) => {
        unknownOutcome = error;
      },
    });
    const outcome = tools[key]
      .execute({}, { toolCallId: "exposure-revoked-effect" })
      .catch((error: unknown) => error);
    await until(
      async () =>
        (await db.chatToolConfirmation.count({
          where: { turnId: scope.turnId, status: "awaiting_user" },
        })) === 1,
    );
    const confirmation = await db.chatToolConfirmation.findFirstOrThrow({
      where: { turnId: scope.turnId },
    });
    await db.deployment.update({
      where: { id: deployment.id },
      data: { mcpAllowedTools: [] },
    });
    const decision = await CONFIRM(
      request(scope.threadId, "POST", {
        confirmationId: confirmation.id,
        approved: true,
      }),
      params(scope.threadId),
    );
    expect(decision.status).toBe(200);
    expect(await outcome).toBeInstanceOf(McpToolNotDispatchedError);
    expect(externalCalls).toBe(0);
    expect(unknownOutcome).toBeUndefined();
    expect(
      await db.chatToolConfirmation.findUniqueOrThrow({
        where: { id: confirmation.id },
      }),
    ).toMatchObject({
      status: "failed",
      error: "MCP tool mutate is not exposed to AI.",
      executionStartedAt: expect.any(Date),
      executionCompletedAt: expect.any(Date),
    });
    expect(
      await db.chatRunEvent.findFirst({
        where: {
          turnId: scope.turnId,
          payload: { path: ["data", "phase"], equals: "failed" },
        },
      }),
    ).not.toBeNull();
    expect(
      await db.chatToolConfirmation.count({
        where: { turnId: scope.turnId, status: "execution_unknown" },
      }),
    ).toBe(0);
    await finishChatTurn(
      scope.threadId,
      scope.turnId,
      "failed",
      "Deployment exposure revoked",
      scope.assistantMessageId,
      [],
      fence,
    );
    await deleteChatThread(userId, scope.threadId);
    expect(
      await db.chatThread.findUnique({ where: { id: scope.threadId } }),
    ).toBeNull();
  });

  it("requires an online actor decision, persists effect claims, and never replays unknown outcomes", async () => {
    const { scope, fence } = await leasedRun();
    let unknownOutcome: unknown;
    const tools = wrapChatTools(
      {
        mutate: {
          name: "mutate",
          description: "Persist a test effect",
          parameters: jsonSchema({ type: "object", properties: {} }),
          execute: async () => {
            const claim = await db.chatToolConfirmation.findUniqueOrThrow({
              where: {
                turnId_toolCallId: {
                  turnId: scope.turnId,
                  toolCallId: "effect",
                },
              },
            });
            expect(claim.status).toBe("executing");
            await db.chatThread.update({
              where: { id: scope.threadId },
              data: { title: "effect committed" },
            });
            throw new Error("Connection lost after commit");
          },
        },
      },
      {
        ...scope,
        fence,
        signal: new AbortController().signal,
        onUnknownOutcome: (error) => {
          unknownOutcome = error;
        },
      },
    );
    const execution = tools.mutate.execute({}, { toolCallId: "effect" });
    const outcome = execution.then(
      () => null,
      (error: unknown) => error,
    );
    await until(
      async () =>
        (await db.chatToolConfirmation.count({
          where: { turnId: scope.turnId, status: "awaiting_user" },
        })) === 1,
    );
    expect(
      (await db.chatThread.findUniqueOrThrow({ where: { id: scope.threadId } }))
        .title,
    ).toBeNull();
    const confirmation = await db.chatToolConfirmation.findFirstOrThrow({
      where: { turnId: scope.turnId },
    });
    const decision = { confirmationId: confirmation.id, approved: true };
    expect(
      (
        await CONFIRM(
          request(scope.threadId, "POST", decision, otherToken),
          params(scope.threadId),
        )
      ).status,
    ).toBe(404);
    await db.membership.create({ data: { workspaceId, userId: otherId } });
    try {
      expect(
        (
          await CONFIRM(
            request(scope.threadId, "POST", decision, otherToken),
            params(scope.threadId),
          )
        ).status,
      ).toBe(404);
    } finally {
      await db.membership.deleteMany({
        where: { workspaceId, userId: otherId },
      });
    }
    expect(
      (
        await CONFIRM(
          request(scope.threadId, "POST", decision),
          params(scope.threadId),
        )
      ).status,
    ).toBe(200);
    expect(await outcome).toBeInstanceOf(Error);
    expect(unknownOutcome).toBe(await outcome);
    expect(
      (
        await db.chatToolConfirmation.findUniqueOrThrow({
          where: { id: confirmation.id },
        })
      ).status,
    ).toBe("execution_unknown");
    expect(
      (await db.chatThread.findUniqueOrThrow({ where: { id: scope.threadId } }))
        .title,
    ).toBe("effect committed");
    await expect(
      tools.mutate.execute({}, { toolCallId: "effect" }),
    ).rejects.toThrow("must not be replayed");
    await db.chatTurn.update({
      where: { id: scope.turnId },
      data: { leaseExpiresAt: new Date(Date.now() - 1) },
    });
    await recoverStaleChatRuns(scope.threadId);
  });

  it("rechecks observer membership while detached generation continues for its actor", async () => {
    const chat = await thread();
    const response = await start(chat.id);
    const turnId = assertDefined(response.headers.get("X-Chat-Run-Id"));
    await until(async () => provider.state().pending === 1);
    await until(async () =>
      JSON.stringify(
        (
          await db.chatMessage.findFirstOrThrow({
            where: { turnId, role: "assistant" },
          })
        ).parts,
      ).includes("Before disconnect."),
    );
    await assertDefined(response.body).cancel();
    await db.membership.create({
      data: { workspaceId, userId: otherId, role: "member" },
    });
    const current = await db.chatTurn.findUniqueOrThrow({
      where: { id: turnId },
    });
    const observer = assertDefined(
      await subscribeChatRun(chat.id, null, {
        userId: otherId,
        workspaceId,
        runId: turnId,
        afterSequence: current.lastEventSequence,
      }),
    );
    await db.membership.deleteMany({ where: { workspaceId, userId: otherId } });
    expect(await observer.stream.getReader().read()).toEqual({
      done: true,
      value: undefined,
    });
    provider.release();
    await until(
      async () =>
        (await db.chatTurn.findUniqueOrThrow({ where: { id: turnId } }))
          .status === "completed",
    );
  });
  it("revokes detached execution and observation when the actor account is suspended", async () => {
    const chat = await thread();
    const response = await start(chat.id);
    const turnId = assertDefined(response.headers.get("X-Chat-Run-Id"));
    await until(async () => provider.state().pending === 1);
    await until(async () =>
      JSON.stringify(
        (
          await db.chatMessage.findFirstOrThrow({
            where: { turnId, role: "assistant" },
          })
        ).parts,
      ).includes("Before disconnect."),
    );
    await assertDefined(response.body).cancel();
    const current = await db.chatTurn.findUniqueOrThrow({
      where: { id: turnId },
    });
    const observer = assertDefined(
      await subscribeChatRun(chat.id, null, {
        userId,
        workspaceId,
        runId: turnId,
        afterSequence: current.lastEventSequence,
      }),
    );
    await db.user.update({
      where: { id: userId },
      data: { status: "suspended" },
    });
    try {
      expect(await observer.stream.getReader().read()).toEqual({
        done: true,
        value: undefined,
      });
      expect(
        await getChatRunSnapshot(chat.id, {
          userId,
          workspaceId,
          runId: turnId,
        }),
      ).toBeNull();
      await until(
        async () =>
          (await db.chatTurn.findUniqueOrThrow({ where: { id: turnId } }))
            .status === "failed",
      );
      await until(async () => provider.state().pending === 0);
    } finally {
      await db.user.update({
        where: { id: userId },
        data: { status: "active" },
      });
    }
  }, 15_000);
  it("publishes terminal chunks only after terminal status and final snapshot commit", async () => {
    const chat = await thread();
    const response = await start(chat.id);
    const turnId = assertDefined(response.headers.get("X-Chat-Run-Id"));
    await until(async () => provider.state().pending === 1);
    provider.release();
    const reader = assertDefined(response.body).getReader();
    const decoder = new TextDecoder();
    let wire = "";
    let terminalObserved = false;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      wire += decoder.decode(chunk.value, { stream: true });
      if (!terminalObserved && wire.includes('"type":"finish"')) {
        terminalObserved = true;
        const turn = await db.chatTurn.findUniqueOrThrow({
          where: { id: turnId },
        });
        const message = await db.chatMessage.findFirstOrThrow({
          where: { turnId, role: "assistant" },
        });
        expect(turn.status).toBe("completed");
        expect(message.status).toBe("success");
        expect(JSON.stringify(message.parts)).toContain("Completed on server.");
      }
    }
    expect(terminalObserved).toBe(true);
    const terminalEvents = await db.chatRunEvent.findMany({
      where: { turnId, payload: { path: ["type"], equals: "finish" } },
    });
    expect(terminalEvents).toHaveLength(1);
  });

  it("refuses thread and Assistant deletion while a real provider Run is active, then permits settled history deletion", async () => {
    const { assistant, chat } = await deletionFixture();
    const response = await start(chat.id);
    const runId = assertDefined(response.headers.get("X-Chat-Run-Id"));
    await until(async () => provider.state().pending === 1);
    await expect(deleteChatThread(userId, chat.id)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      deleteChatAssistant(userId, assistant.id),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await db.chatTurn.findUnique({ where: { id: runId } }),
    ).toMatchObject({ status: "pending" });
    provider.release();
    await response.text();
    await until(
      async () =>
        (await db.chatTurn.findUnique({ where: { id: runId } }))?.status ===
        "completed",
    );
    await deleteChatThread(userId, chat.id);
    await deleteChatAssistant(userId, assistant.id);
    expect(await db.chatTurn.findUnique({ where: { id: runId } })).toBeNull();
  }, 15_000);

  it.each(["executing", "execution_unknown"])(
    "retains terminal Run snapshots and the external-effect ledger while confirmation is %s",
    async (status) => {
      const { assistant, chat } = await deletionFixture();
      const run = await db.chatTurn.create({
        data: {
          threadId: chat.id,
          actorUserId: userId,
        },
      });
      const confirmation = await db.chatToolConfirmation.create({
        data: {
          turnId: run.id,
          toolCallId: "unresolved-mutation",
          toolName: "mutate",
          input: {},
        },
      });
      await db.chatToolConfirmation.update({
        where: { id: confirmation.id },
        data: {
          status: "approved",
          approverUserId: userId,
          resolvedAt: new Date(),
        },
      });
      await db.chatToolConfirmation.update({
        where: { id: confirmation.id },
        data: { status: "executing", executionStartedAt: new Date() },
      });
      if (status === "execution_unknown") {
        await db.chatToolConfirmation.update({
          where: { id: confirmation.id },
          data: {
            status: "execution_unknown",
            error: "Effect result was not observed",
          },
        });
      }
      await db.chatMessage.create({
        data: {
          threadId: chat.id,
          turnId: run.id,
          role: "assistant",
          status: "error",
          parts: [{ type: "text", text: "Retained partial answer" }],
        },
      });
      await db.chatRunEvent.create({
        data: {
          turnId: run.id,
          generation: run.generation,
          sequence: 1,
          payload: {
            type: "text-delta",
            id: "partial",
            delta: "Retained partial answer",
          },
        },
      });
      await db.chatTurn.update({
        where: { id: run.id },
        data: { status: "failed", completedAt: new Date() },
      });
      await expect(deleteChatThread(userId, chat.id)).rejects.toMatchObject({
        status: 409,
      });
      await expect(
        deleteChatAssistant(userId, assistant.id),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await db.chatToolConfirmation.findUnique({
          where: { id: confirmation.id },
        }),
      ).toMatchObject({ status });
      expect(await db.chatRunEvent.count({ where: { turnId: run.id } })).toBe(
        1,
      );
      expect(await db.chatMessage.count({ where: { turnId: run.id } })).toBe(1);
      // Emulate explicit external reconciliation; deletion itself never changes the outcome.
      await db.chatToolConfirmation.update({
        where: { id: confirmation.id },
        data: {
          status: "succeeded",
          executionCompletedAt: new Date(),
          result: { reconciled: true },
        },
      });
      await deleteChatAssistant(userId, assistant.id);
    },
  );

  it("serializes physical thread deletion against actual Run admission on the same PostgreSQL row lock", async () => {
    const { assistant, chat } = await deletionFixture();
    const locked = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const blocker = db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "ChatThread" WHERE "id" = ${chat.id} FOR UPDATE`,
        );
        locked.resolve(assertDefined(rows[0]).pid);
        await release.promise;
      },
      { timeout: 20_000 },
    );
    const blockerPid = await locked.promise;
    const contenders = Promise.allSettled([
      beginChatTurn(
        chat.id,
        [{ type: "text", text: "Racing admission" }],
        { workspaceId, userId },
        { idempotencyKey: randomUUID(), expectedAssistantId: assistant.id },
      ),
      deleteChatThread(userId, chat.id),
    ]);
    try {
      await waitForBlockedTransactions(blockerPid, 2);
    } finally {
      release.resolve();
      await blocker;
    }
    const [admission, deletion] = await contenders;
    if (admission.status === "fulfilled") {
      expect(deletion).toMatchObject({
        status: "rejected",
        reason: { status: 409 },
      });
      expect(
        await db.chatTurn.findUnique({ where: { id: admission.value.id } }),
      ).not.toBeNull();
      await finishChatTurn(
        chat.id,
        admission.value.id,
        "cancelled",
        undefined,
        admission.value.assistantMessageId,
      );
    } else {
      expect(admission.reason).toMatchObject({ status: 404 });
      expect(deletion.status).toBe("fulfilled");
    }
    await deleteChatAssistant(userId, assistant.id);
  }, 25_000);

  it("serializes Assistant deletion with concurrent thread creation and its subsequent Run admission", async () => {
    const { assistant } = await deletionFixture();
    const locked = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const blocker = db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "ChatAssistant" WHERE "id" = ${assistant.id} FOR UPDATE`,
        );
        locked.resolve(assertDefined(rows[0]).pid);
        await release.promise;
      },
      { timeout: 20_000 },
    );
    const blockerPid = await locked.promise;
    const contenders = Promise.allSettled([
      createChatThread(userId, assistant.id, {}).then((chat) =>
        beginChatTurn(
          chat.id,
          [{ type: "text", text: "New thread admission" }],
          { workspaceId, userId },
          { idempotencyKey: randomUUID(), expectedAssistantId: assistant.id },
        ),
      ),
      deleteChatAssistant(userId, assistant.id),
    ]);
    try {
      await waitForBlockedTransactions(blockerPid, 2);
    } finally {
      release.resolve();
      await blocker;
    }
    const [admission, deletion] = await contenders;
    if (admission.status === "fulfilled") {
      expect(deletion).toMatchObject({
        status: "rejected",
        reason: { status: 409 },
      });
      expect(
        await db.chatTurn.findUnique({ where: { id: admission.value.id } }),
      ).not.toBeNull();
      await finishChatTurn(
        admission.value.threadId,
        admission.value.id,
        "cancelled",
        undefined,
        admission.value.assistantMessageId,
      );
      await deleteChatAssistant(userId, assistant.id);
    } else {
      expect(admission.reason).toMatchObject({ status: 404 });
      expect(deletion.status).toBe("fulfilled");
    }
    expect(
      await db.chatThread.count({ where: { assistantId: assistant.id } }),
    ).toBe(0);
  }, 25_000);
});
