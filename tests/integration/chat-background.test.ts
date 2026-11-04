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
  getChatThreadForExecution,
  updateChatAssistant,
} from "@/lib/chat/service";
import { db } from "@/lib/db";
import { createApiToken } from "@/lib/auth/tokens";
import { POST, DELETE } from "@/app/api/v1/chat/threads/[threadId]/turns/route";
import { GET } from "@/app/api/v1/chat/threads/[threadId]/turns/stream/route";
import { GET as GET_STATUS } from "@/app/api/v1/chat/assistants/route";
import {
  GET as PREVIEW_REVISION,
  POST as UPGRADE_REVISION,
} from "@/app/api/v1/chat/threads/[threadId]/revision/route";
import {
  appendChatRunEvent,
  getChatRunSnapshot,
  recoverStaleChatRuns,
  subscribeChatRun,
} from "@/lib/chat/run-control";
import { readChatExecutionProgress } from "@/lib/chat/execution-stage";
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
  it("upgrades a thread in place, retaining history and rejecting foreign revisions, outsiders and active turns", async () => {
    const { assistant, chat } = await deletionFixture();
    const turn = await db.chatTurn.create({
      data: { threadId: chat.id, status: "completed", completedAt: new Date() },
    });
    const message = await db.chatMessage.create({
      data: {
        threadId: chat.id,
        turnId: turn.id,
        role: "user",
        status: "completed",
        parts: [{ type: "text", text: "Keep my original history" }],
      },
    });
    await db.chatThread.update({
      where: { id: chat.id },
      data: { activeMessageId: message.id },
    });
    const foreign = await createChatAssistant(userId, {
      workspaceId,
      name: "Other revision owner",
    });
    await updateChatAssistant(userId, foreign.id, {
      expectedRevision: 1,
      systemPrompt: "Foreign config",
    });
    expect(
      (
        await UPGRADE_REVISION(
          request(chat.id, "POST", { targetVersion: 2 }),
          params(chat.id),
        )
      ).status,
    ).toBe(409);
    const deployment = await db.deployment.create({
      data: {
        workspaceId,
        source: "remote",
        sourceRef: "https://mcp.example.com/mcp",
        name: "Upgrade tools",
        installCfg: {
          transport: "streamable-http",
          authType: "none",
          env: {},
          toolCatalog: [{ name: "read" }, { name: "write" }],
        },
      },
    });
    await updateChatAssistant(userId, assistant.id, {
      expectedRevision: 1,
      systemPrompt: "Updated policy",
      mcpGrants: [{ deploymentId: deployment.id }],
    });
    expect(
      (
        await UPGRADE_REVISION(
          request(chat.id, "POST", { targetVersion: 2 }, otherToken),
          params(chat.id),
        )
      ).status,
    ).toBe(404);
    const preview = await PREVIEW_REVISION(
      new Request(
        `http://localhost/api/v1/chat/threads/${chat.id}/revision?targetVersion=2`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      ),
      params(chat.id),
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      diff: {
        fromVersion: 1,
        toVersion: 2,
        changedFields: ["systemPrompt"],
        mcpGrantsAdded: [
          {
            deploymentId: deployment.id,
            name: "Upgrade tools",
            tools: ["read", "write"],
          },
        ],
      },
    });
    const pending = await db.chatTurn.create({ data: { threadId: chat.id } });
    expect(
      (
        await UPGRADE_REVISION(
          request(chat.id, "POST", { targetVersion: 2 }),
          params(chat.id),
        )
      ).status,
    ).toBe(409);
    await db.chatTurn.update({
      where: { id: pending.id },
      data: { status: "cancelled", completedAt: new Date() },
    });
    const upgraded = await UPGRADE_REVISION(
      request(chat.id, "POST", { targetVersion: 2 }),
      params(chat.id),
    );
    expect(upgraded.status).toBe(200);
    expect(await upgraded.json()).toEqual({ thread: { id: chat.id } });
    const execution = await getChatThreadForExecution(userId, chat.id);
    expect(execution?.messages.map((entry) => entry.id)).toEqual([message.id]);
    expect(execution?.activeMessageId).toBe(message.id);
    expect(execution?.revisionConfig).toMatchObject({
      systemPrompt: "Updated policy",
      mcpGrants: [
        { deploymentId: deployment.id, allowedToolNames: ["read", "write"] },
      ],
    });
    expect(
      (
        await UPGRADE_REVISION(
          request(chat.id, "POST", { targetVersion: 1 }),
          params(chat.id),
        )
      ).status,
    ).toBe(409);
    const foreignRevision = await db.chatAssistantRevision.findUniqueOrThrow({
      where: { assistantId_version: { assistantId: foreign.id, version: 2 } },
    });
    await expect(
      db.chatThread.update({
        where: { id: chat.id },
        data: { assistantRevisionId: foreignRevision.id },
      }),
    ).rejects.toThrow();
    const legacy = await db.chatThread.create({
      data: {
        workspaceId,
        assistantId: assistant.id,
        legacyRevisionUnresolved: true,
      },
    });
    expect(
      (
        await UPGRADE_REVISION(
          request(legacy.id, "POST", { targetVersion: 2 }),
          params(legacy.id),
        )
      ).status,
    ).toBe(409);
  });

  it("uses a turn-local provider/model, retains it in history, and returns to the pinned default without changing the revision", async () => {
    const chat = await thread();
    const revision = await db.chatAssistantRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    const assistantBefore = await db.chatAssistant.findUniqueOrThrow({
      where: { id: assistantId },
    });
    const overrideProvider = await db.modelProvider.create({
      data: {
        workspaceId,
        name: `Turn model ${randomUUID()}`,
        format: "openai",
        baseUrl: `${provider.baseUrl}/v1`,
        apiKey: "local-fixture-only",
        models: ["turn-override-fixture"],
      },
    });
    const key = randomUUID();
    const body = {
      idempotencyKey: key,
      messages: [
        {
          id: randomUUID(),
          role: "user",
          parts: [{ type: "text", text: "Use another model for this turn" }],
        },
      ],
      modelOverride: {
        providerId: overrideProvider.id,
        model: "turn-override-fixture",
      },
    };
    const response = await POST(
      request(chat.id, "POST", body),
      params(chat.id),
    );
    expect(response.status).toBe(200);
    const runId = assertDefined(response.headers.get("X-Chat-Run-Id"));
    await until(
      async () =>
        provider.state().pending === 1 &&
        provider.models().at(-1) === "turn-override-fixture",
    );
    provider.release();
    const stream = await response.text();
    expect(stream).toContain('"type":"data-model"');
    await until(
      async () =>
        (await db.chatTurn.findUniqueOrThrow({ where: { id: runId } }))
          .status === "completed",
    );
    const answer = await db.chatMessage.findFirstOrThrow({
      where: { turnId: runId, role: "assistant" },
    });
    expect(answer.modelId).toBe("turn-override-fixture");
    expect(answer.parts).toContainEqual({
      type: "data-model",
      data: body.modelOverride,
    });
    const changedReplay = await POST(
      request(chat.id, "POST", { ...body, modelOverride: undefined }),
      params(chat.id),
    );
    expect(changedReplay.status).toBe(409);
    const defaultResponse = await start(chat.id);
    await until(
      async () =>
        provider.state().pending === 1 &&
        provider.models().at(-1) === "chat-background-fixture",
    );
    provider.release();
    await defaultResponse.text();
    const defaultRunId = assertDefined(
      defaultResponse.headers.get("X-Chat-Run-Id"),
    );
    await until(
      async () =>
        (await db.chatTurn.findUniqueOrThrow({ where: { id: defaultRunId } }))
          .status === "completed",
    );
    const defaultAnswer = await db.chatMessage.findFirstOrThrow({
      where: { turnId: defaultRunId, role: "assistant" },
    });
    expect(defaultAnswer.modelId).toBe("chat-background-fixture");
    expect(
      await db.chatAssistantRevision.findUniqueOrThrow({
        where: { id: revisionId },
      }),
    ).toEqual(revision);
    expect(
      await db.chatAssistant.findUniqueOrThrow({ where: { id: assistantId } }),
    ).toEqual(assistantBefore);
  });

  it("rejects foreign providers, missing credentials, unlisted models, and incompatible capabilities before admitting a Run", async () => {
    const chat = await thread();
    const foreignWorkspace = await db.workspace.create({
      data: {
        ownerId: otherId,
        name: "Foreign model scope",
        slug: `foreign-model-${randomUUID()}`,
      },
    });
    try {
      const foreign = await db.modelProvider.create({
        data: {
          workspaceId: foreignWorkspace.id,
          name: "Foreign",
          format: "openai",
          baseUrl: `${provider.baseUrl}/v1`,
          apiKey: "fixture",
          models: ["foreign-text"],
        },
      });
      const unavailable = await db.modelProvider.create({
        data: {
          workspaceId,
          name: `Missing credential ${randomUUID()}`,
          format: "openai",
          baseUrl: `${provider.baseUrl}/v1`,
          apiKey: "",
          models: ["text-model"],
        },
      });
      const scoped = await db.modelProvider.create({
        data: {
          workspaceId,
          name: `Capabilities ${randomUUID()}`,
          format: "openai",
          baseUrl: `${provider.baseUrl}/v1`,
          apiKey: "fixture",
          models: ["text-only", "embedding-only"],
          modelRecords: {
            create: [
              { modelId: "text-only", name: "Text only", primaryType: "text" },
              {
                modelId: "embedding-only",
                name: "Embedding",
                primaryType: "embedding",
              },
            ],
          },
        },
      });
      const cases = [
        {
          providerId: foreign.id,
          model: "foreign-text",
          error: "CHAT_MODEL_PROVIDER_UNAVAILABLE",
        },
        {
          providerId: unavailable.id,
          model: "text-model",
          error: "CHAT_MODEL_PROVIDER_UNAVAILABLE",
        },
        {
          providerId: scoped.id,
          model: "not-configured",
          error: "CHAT_MODEL_NOT_AVAILABLE",
        },
        {
          providerId: scoped.id,
          model: "embedding-only",
          error: "CHAT_MODEL_CAPABILITY_UNSUPPORTED",
        },
        {
          providerId: scoped.id,
          model: "text-only",
          webSearchEnabled: true,
          error: "CHAT_MODEL_CAPABILITY_UNSUPPORTED",
        },
        {
          providerId: scoped.id,
          model: "text-only",
          reasoningEffort: "high",
          error: "CHAT_MODEL_CAPABILITY_UNSUPPORTED",
        },
      ];
      const calls = provider.state().calls;
      for (const testCase of cases) {
        const response = await POST(
          request(chat.id, "POST", {
            idempotencyKey: randomUUID(),
            messages: [
              {
                id: randomUUID(),
                role: "user",
                parts: [{ type: "text", text: "Do not dispatch" }],
              },
            ],
            modelOverride: {
              providerId: testCase.providerId,
              model: testCase.model,
            },
            webSearchEnabled: testCase.webSearchEnabled,
            reasoningEffort: testCase.reasoningEffort,
          }),
          params(chat.id),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: testCase.error });
      }
      expect(await db.chatTurn.count({ where: { threadId: chat.id } })).toBe(0);
      expect(provider.state().calls).toBe(calls);
    } finally {
      await db.workspace.delete({ where: { id: foreignWorkspace.id } });
    }
  });

  it("restores model waiting independently from generation and replays stages without changing saved history", async () => {
    const resumeFirstOutput = provider.pauseNextResponse();
    const chat = await thread();
    try {
      const response = await start(chat.id);
      const runId = assertDefined(response.headers.get("X-Chat-Run-Id"));
      const state = () =>
        getChatRunSnapshot(chat.id, { userId, workspaceId, runId });
      await until(async () => provider.state().pending === 1);
      await until(async () => (await state())?.phase === "waiting-model");
      const waiting = assertDefined(await state());
      expect(waiting.execution).toMatchObject({
        runId,
        stage: "waiting-model",
      });
      expect(
        waiting.messages
          .filter((message) => message.role === "assistant")
          .some(
            (message) =>
              Array.isArray(message.parts) &&
              message.parts.some(
                (part) =>
                  part &&
                  typeof part === "object" &&
                  "type" in part &&
                  part.type === "text",
              ),
          ),
      ).toBe(false);
      const replay = await GET(
        new Request(
          `http://localhost/api/v1/chat/threads/${chat.id}/turns/stream?runId=${runId}&afterSequence=${waiting.cursor}`,
          { headers: { authorization: `Bearer ${token}` } },
        ),
        params(chat.id),
      );
      resumeFirstOutput();
      await until(
        async () => (await state())?.execution?.stage === "generating",
      );
      provider.release();
      await response.text();
      const replayed = (await replay.text())
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .map((line) => JSON.parse(line.slice(6)));
      expect(replayed).toContainEqual(
        expect.objectContaining({
          type: "data-chat-execution",
          transient: true,
          data: expect.objectContaining({ runId, stage: "generating" }),
        }),
      );
      const events = await db.chatRunEvent.findMany({
        where: { turnId: runId },
        orderBy: { sequence: "asc" },
      });
      const stages = events.flatMap((event) => {
        const payload = event.payload as { type: string; data?: unknown };
        const progress =
          payload.type === "data-chat-execution"
            ? readChatExecutionProgress(payload.data)
            : null;
        return progress ? [progress.stage] : [];
      });
      expect(stages).toEqual([
        "queued",
        "preparing",
        "waiting-model",
        "generating",
      ]);
      const completed = assertDefined(await state());
      expect(completed.phase).toBe("completed");
      expect(
        completed.messages.every(
          (message) =>
            Array.isArray(message.parts) &&
            message.parts.every(
              (part) =>
                !part ||
                typeof part !== "object" ||
                !("type" in part) ||
                part.type !== "data-chat-execution",
            ),
        ),
      ).toBe(true);
    } finally {
      resumeFirstOutput();
      provider.release();
    }
  });

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
      {
        type: "data-model",
        data: {
          providerId: expect.any(String),
          model: "chat-background-fixture",
        },
      },
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
      {
        type: "data-model",
        data: {
          providerId: expect.any(String),
          model: "chat-background-fixture",
        },
      },
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
    await db.chatToolConfirmation.create({
      data: {
        turnId: scope.turnId,
        toolCallId: "lost-effect",
        toolName: "mutate",
        input: {},
        status: "executing",
        executionStartedAt: new Date(),
      },
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

  it("settles a proven pre-dispatch revocation without an unknown effect or deletion blockade", async () => {
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
    await db.chatAssistantMcpGrant.delete({
      where: { assistantId_deploymentId: grantKey },
    });
    const outcome = await tools.mutate
      .execute({}, { toolCallId: "revoked-effect" })
      .catch((error: unknown) => error);
    const confirmation = await db.chatToolConfirmation.findFirstOrThrow({
      where: { turnId: scope.turnId },
    });
    expect(outcome).toBeInstanceOf(McpToolNotDispatchedError);
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

  it("rechecks deployment exposure after discovery and before automatic dispatch", async () => {
    const { scope, fence } = await leasedRun();
    const deployment = await db.deployment.create({
      data: {
        workspaceId,
        name: "Automatic exposure revocation fixture",
        source: "remote",
        sourceRef: "https://mcp.example.test/automatic-effect",
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
    await db.deployment.update({
      where: { id: deployment.id },
      data: { mcpAllowedTools: [] },
    });
    const outcome = tools[key]
      .execute({}, { toolCallId: "exposure-revoked-effect" })
      .catch((error: unknown) => error);
    const error = await outcome;
    const confirmation = await db.chatToolConfirmation.findFirstOrThrow({
      where: { turnId: scope.turnId },
    });
    expect(error).toBeInstanceOf(McpToolNotDispatchedError);
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

  it("commits an automatic claim before dispatch, rejects duplicates, and settles after cancellation", async () => {
    const { scope, fence } = await leasedRun();
    const controller = new AbortController();
    const release = Promise.withResolvers<void>();
    let externalCalls = 0;
    const result = { content: [{ type: "text", text: "effect completed" }] };
    const tools = wrapChatTools(
      {
        mutate: {
          name: "mutate",
          description: "Persist an automatically authorized effect",
          parameters: jsonSchema({ type: "object", properties: {} }),
          execute: async () => {
            const claim = await db.chatToolConfirmation.findUniqueOrThrow({
              where: {
                turnId_toolCallId: {
                  turnId: scope.turnId,
                  toolCallId: "automatic",
                },
              },
            });
            expect(claim).toMatchObject({
              status: "executing",
              approverUserId: null,
              resolvedAt: null,
              executionStartedAt: expect.any(Date),
            });
            const event = await db.chatRunEvent.findFirstOrThrow({
              where: {
                turnId: scope.turnId,
                payload: { path: ["data", "toolCallId"], equals: "automatic" },
              },
            });
            expect(event.payload).toMatchObject({
              data: { phase: "tool_calling" },
            });
            externalCalls += 1;
            await release.promise;
            return result;
          },
        },
      },
      { ...scope, fence, signal: controller.signal },
    );
    const outcome = tools.mutate
      .execute({}, { toolCallId: "automatic" })
      .catch((error: unknown) => error);
    try {
      await until(async () => externalCalls === 1);
      const snapshot = assertDefined(
        await getChatRunSnapshot(scope.threadId, { userId, workspaceId }),
      );
      expect(snapshot.phase).toBe("tool_calling");
      expect(snapshot.execution).toMatchObject({
        runId: scope.turnId,
        stage: "tool-running",
      });
      expect(snapshot.confirmations).toHaveLength(1);
      expect(snapshot.confirmations[0].status).toBe("executing");
      await expect(
        tools.mutate.execute({}, { toolCallId: "automatic" }),
      ).rejects.toThrow("must not be replayed");
      controller.abort(
        new DOMException("Stopped after dispatch", "AbortError"),
      );
    } finally {
      release.resolve();
    }
    expect(await outcome).toEqual(result);
    expect(externalCalls).toBe(1);
    expect(
      await db.chatToolConfirmation.findFirstOrThrow({
        where: { turnId: scope.turnId },
      }),
    ).toMatchObject({
      status: "succeeded",
      result,
      executionCompletedAt: expect.any(Date),
    });
    const events = await db.chatRunEvent.findMany({
      orderBy: { sequence: "asc" },
      where: {
        turnId: scope.turnId,
        payload: { path: ["type"], equals: "data-chat-tool" },
      },
    });
    expect(events.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ phase: "tool_calling" }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({ phase: "succeeded" }),
      }),
    ]);
    const replayTools = wrapChatTools(tools, {
      ...scope,
      fence,
      signal: new AbortController().signal,
    });
    await expect(
      replayTools.mutate.execute({}, { toolCallId: "automatic" }),
    ).rejects.toThrow("must not be replayed");
    await finishChatTurn(
      scope.threadId,
      scope.turnId,
      "cancelled",
      "Stopped after dispatch",
      scope.assistantMessageId,
      [],
      fence,
    );
  });

  it.each(["stop", "actor", "workspace", "fence", "abort"] as const)(
    "does not dispatch or persist a claim after %s authority is lost",
    async (reason) => {
      const { scope, fence } = await leasedRun();
      const controller = new AbortController();
      const toolScope = {
        ...scope,
        fence: { ...fence },
        signal: controller.signal,
      };
      if (reason === "stop")
        await db.chatTurn.update({
          where: { id: scope.turnId },
          data: { stopRequestedAt: new Date() },
        });
      if (reason === "actor") toolScope.userId = otherId;
      if (reason === "workspace") toolScope.workspaceId = randomUUID();
      if (reason === "fence") toolScope.fence.generation += 1;
      if (reason === "abort") controller.abort();
      let externalCalls = 0;
      const tools = wrapChatTools(
        {
          mutate: {
            name: "mutate",
            description: "Must not execute without live authority",
            parameters: jsonSchema({ type: "object", properties: {} }),
            execute: async () => {
              externalCalls += 1;
              return {};
            },
          },
        },
        toolScope,
      );
      await expect(
        tools.mutate.execute({}, { toolCallId: "unauthorized" }),
      ).rejects.toThrow();
      expect(externalCalls).toBe(0);
      expect(
        await db.chatToolConfirmation.count({
          where: { turnId: scope.turnId },
        }),
      ).toBe(0);
      expect(
        await db.chatRunEvent.count({ where: { turnId: scope.turnId } }),
      ).toBe(0);
      await finishChatTurn(
        scope.threadId,
        scope.turnId,
        "failed",
        "Authority revoked",
        scope.assistantMessageId,
        [],
        fence,
      );
    },
  );

  it("executes without an actor decision and never replays unknown outcomes", async () => {
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
    const outcome = await tools.mutate
      .execute({}, { toolCallId: "effect" })
      .catch((error: unknown) => error);
    const confirmation = await db.chatToolConfirmation.findFirstOrThrow({
      where: { turnId: scope.turnId },
    });
    expect(outcome).toBeInstanceOf(Error);
    expect(unknownOutcome).toBe(outcome);
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
    "retains terminal Run snapshots and the external-effect ledger while the effect is %s",
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
          status: "executing",
          executionStartedAt: new Date(),
        },
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
