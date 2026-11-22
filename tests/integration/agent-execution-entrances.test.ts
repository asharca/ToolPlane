// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import * as transport from "@/lib/account-connections/pinned-get";
import { encryptSecretRecord } from "@/lib/security/secrets";
import { createConversation } from "@/lib/agents/conversation-mutations";
import { getAgentForRun, getConversation } from "@/lib/agents/queries";
import { resolveAgentRequestSession } from "@/lib/agents/request-session";
import { isAgentRuntimeGrantCurrent } from "@/lib/agents/runtime-grant";
import { serveHistoricalSandboxFiles } from "@/lib/agents/historical-sandbox";
import { publishFixtureAgentRevision } from "./agent-revision-fixture";
import { resolveAgentModelOverride } from "@/lib/agents/turn-model";
import { resolvePinnedAgent } from "@/lib/agents/revisions";
import { parseAgentChatBody } from "@/lib/agents/chat-body";
import { Artifact, TaskState } from "@a2a-js/sdk";
import { submitAgentEntry } from "@/lib/agents/execution/entries";
import { claimTask, finishTask } from "@/lib/a2a/store";
import {
  recordAgentModelUsage,
  recordAgentTaskUsage,
} from "@/lib/agents/usage";
import {
  taskBudgetWarning,
  appendBudgetWarningText,
} from "@/lib/agents/budget-warning";
import { ModelResponseUsage } from "@/lib/agents/model-response-usage";
import {
  handleAgentAutomation,
  handleTriggerWebhook,
} from "@/lib/agents/automation-http";
import {
  deliverPendingTrigger,
  newTriggerSecret,
  settleAgentTriggerTask,
} from "@/lib/agents/triggers";
import { createApiToken } from "@/lib/auth/tokens";
import type * as SandboxRuntimeModule from "@/lib/agents/sandbox-runtime";
import { ENTRY_KINDS } from "@/lib/agents/entry-kinds";
import {
  createAgentRuntimeToken,
  verifyAgentRuntimeToken,
} from "@/lib/agents/runtime-access";
import { mapTaskSandbox } from "./task-sandbox-fixture";
import * as worker from "@/lib/agents/execution/worker";

// Entrance authorization exercises real revisions without Docker SDK preparation.
vi.mock("@/lib/agents/pi-runtime", () => ({
  preparePiRuntime: vi.fn(async () => ({
    path: "/fixture/pi-sdk.archive",
    sha256: "a".repeat(64),
  })),
}));
vi.mock("@/lib/agents/sandbox-runtime", async (original) => ({
  ...(await original<typeof SandboxRuntimeModule>()),
  preflightPiSdkCapabilities: vi
    .fn()
    .mockResolvedValue({ commands: [], tools: [], skills: [], prompts: [] }),
}));

const stamp = randomUUID();
let userId = "";
let workspaceId = "";
let providerId = "";
let sequence = 0;
beforeAll(async () => {
  const user = await db.user.create({
    data: {
      email: `agent-entrances-${stamp}@test.invalid`,
      passwordHash: "fixture",
    },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      ownerId: userId,
      slug: `agent-entrances-${stamp}`,
      name: "Agent entrances",
      members: { create: { userId, role: "owner" } },
    },
  });
  workspaceId = workspace.id;
  const provider = await db.modelProvider.create({
    data: {
      workspaceId,
      name: "Fixture",
      format: "openai",
      baseUrl: "https://fixture.test.invalid",
      apiKey: "fixture",
      models: ["original", "future"],
    },
  });
  providerId = provider.id;
  await db.providerModel.create({
    data: {
      providerId,
      modelId: "original",
      name: "Original",
      cost: { input: 1 },
    },
  });
});
afterAll(async () => {
  if (workspaceId) {
    await db.a2AContext.deleteMany({ where: { workspaceId } });
    await db.conversation.deleteMany({ where: { agent: { workspaceId } } });
    await db.workspace.delete({ where: { id: workspaceId } });
  }
  if (userId) await db.user.delete({ where: { id: userId } });
});
async function fixture() {
  const slug = `entrance-${++sequence}`;
  const deployment = await db.deployment.create({
    data: { workspaceId, source: "sandbox", status: "stopped" },
  });
  const sandbox = await db.sandbox.create({
    data: {
      workspaceId,
      deploymentId: deployment.id,
      name: slug,
      slug,
      kind: "docker",
      network: "isolated",
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: slug,
      slug,
      runtimeKind: "pi-sdk",
      providerId,
      model: "original",
      systemPrompt: "Original prompt",
      sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } },
    },
  });
  const revision = await publishFixtureAgentRevision(workspaceId, agent.id);
  const conversation = await createConversation(workspaceId, agent.id);
  if (!conversation) throw new Error("Missing conversation fixture");
  return { agent, sandbox, revision, conversation };
}

describe.sequential("Agent execution entrance revision boundaries", () => {
  it("keeps the migrated PostgreSQL entry kind constraint in sync", async () => {
    const [constraint] = await db.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = '"A2AEntryBinding"'::regclass
        AND conname = 'A2AEntryBinding_kind_check'
        AND contype = 'c'
        AND convalidated
    `;
    if (!constraint) throw new Error("Missing validated entry kind check");
    // PostgreSQL normalizes a text column's IN list to = ANY (ARRAY[...]).
    const list =
      /^CHECK \(\(kind = ANY \(ARRAY\[((?:'[a-z0-9_]+'::text, )*'[a-z0-9_]+'::text)\]\)\)\)$/.exec(
        constraint.definition,
      );
    if (!list)
      throw new Error(`Unexpected entry kind check: ${constraint.definition}`);
    const kinds = [...list[1].matchAll(/'([a-z0-9_]+)'/g)].map(
      (match) => match[1],
    );
    expect(kinds.sort()).toEqual([...ENTRY_KINDS].sort());
  });

  it.each(ENTRY_KINDS)(
    "grants runtime access to the %s entry",
    async (kind) => {
      const { agent, sandbox, revision, conversation } = await fixture();
      const scope = { workspaceId, agentId: agent.id };
      let sourceId = conversation.id;
      let channelId: string | undefined;
      if (kind === "work") {
        const work = await db.workSession.create({
          data: {
            ...scope,
            conversationId: conversation.id,
            agentRevisionId: revision.id,
            legacyRevisionUnresolved: false,
            a2aActorId: userId,
            runtimeKind: "pi-sdk",
            runtimeSnapshot: { workingDirectory: "." },
          },
        });
        sourceId = work.id;
      } else if (kind === "channel") {
        const channel = await db.agentChannelConnection.create({
          data: {
            ...scope,
            sandboxId: sandbox.id,
            a2aActorId: userId,
            name: "Runtime grant fixture",
            platform: "weixin",
            status: "running",
            inboundTokenHash: randomUUID(),
            inboundTokenSecret: {},
            inboundTokenPrefix: "fixture",
          },
        });
        channelId = channel.id;
        await db.conversation.update({
          where: { id: conversation.id },
          data: { runtimeSessionKey: `channel:${channel.id}:fixture` },
        });
      } else if (kind === "trigger") {
        const trigger = await db.agentTrigger.create({
          data: {
            ...scope,
            actorId: userId,
            kind: "webhook",
            name: "Runtime grant fixture",
            prompt: "Run",
            secretHash: newTriggerSecret().secretHash,
          },
        });
        sourceId = trigger.id;
      }
      const admitted = await submitAgentEntry(
        {
          ...scope,
          kind,
          sourceId,
          channelId,
          ...(kind === "trigger" ? { conversationId: conversation.id } : {}),
          actorId: userId,
          messageId: randomUUID(),
          text: "Entry contract",
        },
        () => {},
      );
      const claimed = await claimTask(admitted.row.id);
      if (!claimed?.leaseToken) throw new Error("Missing task lease");
      // Provisioning is the only fixture boundary: the mapping, lease, and grant
      // are checked against real persisted data by the sandbox and grant resolvers.
      const mapping = await mapTaskSandbox(claimed);
      const token = await verifyAgentRuntimeToken(
        await createAgentRuntimeToken({
          ...scope,
          agentRevisionId: revision.id,
          sandboxId: mapping.sandboxId,
          conversationId: conversation.id,
          a2aContextId: claimed.contextId,
          a2aTaskId: claimed.id,
          a2aLeaseToken: claimed.leaseToken,
          providerId,
          deploymentIds: [],
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      );
      if (!token) throw new Error("Missing signed runtime token");
      await expect(isAgentRuntimeGrantCurrent(token)).resolves.toBe(true);
      await expect(
        isAgentRuntimeGrantCurrent({ ...token, a2aLeaseToken: randomUUID() }),
      ).resolves.toBe(false);
      await expect(
        isAgentRuntimeGrantCurrent({ ...token, conversationId: randomUUID() }),
      ).resolves.toBe(false);
    },
  );

  it("rejects new admission at the monthly budget and meters a settled task only once", async () => {
    const { agent, conversation } = await fixture();
    const input = {
      kind: "chat" as const,
      sourceId: conversation.id,
      workspaceId,
      agentId: agent.id,
      actorId: userId,
      messageId: randomUUID(),
      text: "budget invariant",
    };
    await db.agent.update({
      where: { id: agent.id },
      data: { monthlyBudgetMicros: BigInt(0) },
    });
    await expect(submitAgentEntry(input, () => {})).rejects.toThrow(
      "AGENT_BUDGET_EXCEEDED",
    );
    expect(
      await db.a2ATask.count({ where: { context: { agentId: agent.id } } }),
    ).toBe(0);
    await db.agent.update({
      where: { id: agent.id },
      data: { monthlyBudgetMicros: BigInt(1_000_000) },
    });
    const admitted = await submitAgentEntry(input, () => {});
    const claimed = await claimTask(admitted.row.id);
    if (!claimed?.leaseToken) throw new Error("Missing task lease");
    await finishTask(
      claimed.id,
      claimed.leaseToken,
      TaskState.TASK_STATE_FAILED,
      "PI_SDK_MODEL_FAILED",
    );
    const metering = {
      model: "original",
      providerId,
      usage: {
        inputTokens: 100,
        outputTokens: 5,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
        costUsd: 0.85,
      },
    };
    await recordAgentTaskUsage(claimed, metering);
    await recordAgentTaskUsage(claimed, metering);
    expect(await db.agentUsage.count({ where: { taskId: claimed.id } })).toBe(
      1,
    );
    expect(
      await db.agentUsage.findUniqueOrThrow({ where: { taskId: claimed.id } }),
    ).toMatchObject({ costMicros: BigInt(850000), succeeded: false });
    expect(
      await db.notification.count({
        where: { workspaceId, kind: "agent_budget_alert" },
      }),
    ).toBe(1);
    await db.agent.update({
      where: { id: agent.id },
      data: { monthlyBudgetMicros: BigInt(850000) },
    });
    await expect(
      submitAgentEntry({ ...input, messageId: randomUUID() }, () => {}),
    ).rejects.toThrow("AGENT_BUDGET_EXCEEDED");
  });
  it("includes advisor tokens in Agent totals and prices each model independently", async () => {
    const { agent, conversation } = await fixture();
    const reviewer = await db.modelProvider.create({
      data: {
        workspaceId,
        name: `Review ${randomUUID()}`,
        format: "openai",
        baseUrl: "https://review.test.invalid",
        apiKey: "fixture",
        models: ["review"],
      },
    });
    await db.providerModel.upsert({
      where: { providerId_modelId: { providerId, modelId: "original" } },
      create: {
        providerId,
        modelId: "original",
        name: "Primary",
        cost: { input: 1, output: 2 },
      },
      update: { cost: { input: 1, output: 2 } },
    });
    await db.providerModel.create({
      data: {
        providerId: reviewer.id,
        modelId: "review",
        name: "Reviewer",
        cost: { input: 10, output: 20 },
      },
    });
    const admitted = await submitAgentEntry(
      {
        kind: "chat",
        sourceId: conversation.id,
        workspaceId,
        agentId: agent.id,
        actorId: userId,
        messageId: randomUUID(),
        text: "review accounting",
      },
      () => {},
    );
    const claimed = await claimTask(admitted.row.id);
    if (!claimed?.leaseToken) throw new Error("Missing task lease");
    await finishTask(
      claimed.id,
      claimed.leaseToken,
      TaskState.TASK_STATE_FAILED,
      "PI_SDK_MODEL_FAILED",
    );
    const metering = {
      providerId,
      model: "original",
      usage: {
        inputTokens: 150,
        outputTokens: 15,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        modelUsage: [
          {
            providerId,
            model: "original",
            inputTokens: 100,
            outputTokens: 10,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          {
            providerId: reviewer.id,
            model: "review",
            inputTokens: 50,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        ],
      },
    };
    await recordAgentTaskUsage(claimed, metering);
    await recordAgentTaskUsage(claimed, metering);
    expect(await db.agentUsage.count({ where: { taskId: claimed.id } })).toBe(
      1,
    );
    expect(
      await db.agentUsage.findUniqueOrThrow({ where: { taskId: claimed.id } }),
    ).toMatchObject({
      inputTokens: 150,
      outputTokens: 15,
      costMicros: BigInt(720),
      succeeded: false,
    });
  });

  it.each([120_000, 220_000])(
    "warns once without failing the turn and reconciles terminal usage to %i input tokens",
    async (finalInput) => {
      const { agent, conversation } = await fixture();
      await db.agent.update({
        where: { id: agent.id },
        data: { monthlyBudgetMicros: BigInt(1_000_000) },
      });
      await db.agentUsage.create({
        data: {
          workspaceId,
          agentId: agent.id,
          conversationId: conversation.id,
          taskId: randomUUID(),
          entryKind: "chat",
          inputTokens: 900_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costMicros: BigInt(900_000),
          succeeded: true,
        },
      });
      const input = {
        kind: "chat" as const,
        sourceId: conversation.id,
        workspaceId,
        agentId: agent.id,
        actorId: userId,
        messageId: randomUUID(),
        text: "finish this turn",
      };
      const admitted = await submitAgentEntry(input, () => {});
      const claimed = await claimTask(admitted.row.id);
      if (!claimed?.leaseToken) throw new Error("Missing task lease");
      const scope = { workspaceId, agentId: agent.id, taskId: claimed.id };
      const token = {
        workspaceId,
        agentId: agent.id,
        providerId,
        a2aTaskId: claimed.id,
        a2aLeaseToken: claimed.leaseToken,
      };
      for (let request = 0; request < 3; request++) {
        // Exercise the same chunked provider usage observer as the model gateway.
        const observer = new ModelResponseUsage(true);
        const bytes = new TextEncoder().encode(
          `data: ${JSON.stringify({
            usage: { prompt_tokens: 70_000, completion_tokens: 0 },
          })}\n\ndata: [DONE]\n\n`,
        );
        observer.push(bytes.slice(0, 17));
        observer.push(bytes.slice(17));
        const usage = observer.finish();
        if (!usage) throw new Error("Missing provider usage");
        await recordAgentModelUsage(token, {
          usage,
          model: "original",
          providerId,
        });
        expect(
          (await db.a2ATask.findUniqueOrThrow({ where: { id: claimed.id } }))
            .state,
        ).toBe(TaskState.TASK_STATE_WORKING);
        if (!request) expect(await taskBudgetWarning(scope)).toBeUndefined();
      }
      expect(await taskBudgetWarning(scope)).toMatchObject({
        taskId: claimed.id,
        agentId: agent.id,
        spentMicros: "1040000",
        monthlyBudgetMicros: "1000000",
        currency: "USD",
        unit: "micros",
      });
      const usage = {
        inputTokens: finalInput,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      await finishTask(
        claimed.id,
        claimed.leaseToken,
        TaskState.TASK_STATE_COMPLETED,
        undefined,
        Artifact.fromJSON({
          artifactId: randomUUID(),
          parts: [{ text: "Finished successfully." }],
          metadata: {
            toolplanePiSdk: {
              commands: [],
              usage,
              model: { providerId, model: "original" },
            },
          },
        }),
      );
      await recordAgentTaskUsage(claimed);
      await recordAgentTaskUsage(claimed);
      // A late gateway completion cannot add a second bill after reconciliation.
      await recordAgentModelUsage(token, {
        usage,
        model: "original",
        providerId,
      });
      expect(
        (await db.a2ATask.findUniqueOrThrow({ where: { id: claimed.id } }))
          .state,
      ).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(
        await db.agentUsage.findUniqueOrThrow({
          where: { taskId: claimed.id },
        }),
      ).toMatchObject({
        ...usage,
        costMicros: BigInt(finalInput),
        succeeded: true,
        meteringCompleted: true,
      });
      expect(await db.agentUsage.count({ where: { taskId: claimed.id } })).toBe(
        1,
      );
      expect(
        await db.logEvent.count({
          where: {
            workspaceId,
            agentId: agent.id,
            taskId: claimed.id,
            eventName: "agent.budget.exceeded",
          },
        }),
      ).toBe(1);
      expect(
        await appendBudgetWarningText("Finished successfully.", scope),
      ).toContain("Finished successfully.\n\n");
      await expect(
        submitAgentEntry({ ...input, messageId: randomUUID() }, () => {}),
      ).rejects.toThrow("AGENT_BUDGET_EXCEEDED");
    },
  );

  it("seeds HTTP items and admits new matching IDs and revisions once without exposing credentials", async () => {
    const { agent } = await fixture();
    const token = (await createApiToken(userId, "Subscription management"))
      .token;
    const credential = `fixture-${randomUUID()}`;
    const api = (
      method: string,
      action: "triggers" | "trigger" | "run",
      id?: string,
      body?: unknown,
    ) =>
      handleAgentAutomation(
        new Request("http://localhost/api", {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
        agent.id,
        action,
        id,
      );
    const connection = await db.accountConnection.create({
      data: {
        workspaceId,
        name: "HTTP fixture",
        preset: "custom",
        authType: "bearer",
        config: { allowedHosts: ["example.org"] },
        status: "active",
        encryptedSecret: encryptSecretRecord({ value: credential }),
      },
    });
    const config = {
      kind: "http",
      connectionId: connection.id,
      cron: "*/5 * * * *",
      timezone: "UTC",
      name: "Reviews",
      prompt: "Check {{payload}}",
      sourceConfig: {
        url: "https://example.org/notifications",
        itemsPath: "",
        idPath: "id",
        revisionPath: "updated_at",
        filters: [
          { path: "reason", values: ["REVIEW_REQUESTED"] },
          { path: "repository.full_name", values: ["owner/project"] },
        ],
      },
    };
    const created = await api("POST", "triggers", undefined, config);
    expect(created.status).toBe(201);
    const dto = (await created.json()).trigger;
    expect(dto.source).toEqual({
      config: config.sourceConfig,
      connection: {
        id: connection.id,
        name: connection.name,
        status: "active",
        accountLabel: null,
      },
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
      syncRetryAt: null,
    });
    expect(JSON.stringify(dto)).not.toContain(credential);
    const renamed = await api("PATCH", "trigger", dto.id, { name: "Renamed" });
    expect(renamed.status).toBe(200);

    const thread = {
      id: "42",
      reason: "review_requested",
      updated_at: "2026-11-01T10:00:00Z",
      repository: { full_name: "owner/project", private: true },
      subject: {
        title: "Review PR",
        type: "PullRequest",
        url: "https://api.github.com/repos/owner/project/pulls/7",
      },
    };
    const rest = vi
      .spyOn(transport, "pinnedGet")
      .mockImplementation(async (url, headers) => {
        expect(url.href).toBe(config.sourceConfig.url);
        expect(headers.authorization).toBe(`Bearer ${credential}`);
        expect(headers["user-agent"]).toBe("ToolPlane");
        return {
          status: 200,
          headers: new Headers(),
          text: JSON.stringify([
            thread,
            thread,
            { ...thread, id: "88", reason: "comment" },
          ]),
        };
      });
    const wake = vi
      .spyOn(worker, "wakeAgentWorker")
      .mockImplementation(() => {});
    try {
      const poll = async () => {
        const res = await api("POST", "run", dto.id);
        expect(res.status).toBe(202);
        return (await res.json()).conversationId;
      };
      expect(await poll()).toBeNull();
      expect(await poll()).toBeNull();
      expect(
        await db.agentTriggerItem.count({ where: { triggerId: dto.id } }),
      ).toBe(1);
      expect(
        await db.conversation.count({ where: { triggerId: dto.id } }),
      ).toBe(0);
      for (const revision of ["2026-11-02T10:00:00Z", "2026-11-03T10:00:00Z"]) {
        thread.id = "43";
        thread.updated_at = revision;
        const conversationId = await poll();
        expect(typeof conversationId).toBe("string");
        const message = await db.message.findFirstOrThrow({
          where: { conversationId, role: "user" },
        });
        const parts = JSON.stringify(message.parts);
        expect(parts).toContain(thread.subject.url);
        expect(parts).toContain(revision);
        expect(parts).toContain("untrusted");
        expect(parts).not.toContain(credential);
        expect(parts).not.toContain("aes-256-gcm");
        expect(await poll()).toBeNull();
      }
      expect(
        await db.conversation.count({ where: { triggerId: dto.id } }),
      ).toBe(2);
      const reset = Math.ceil(Date.now() / 1000) + 120;
      rest.mockResolvedValueOnce({
        status: 429,
        headers: new Headers({ "x-ratelimit-reset": String(reset) }),
        text: "",
      });
      const limited = await api("POST", "run", dto.id);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({
        error: "SUBSCRIPTION_RATE_LIMITED",
      });
      const list = await (await api("GET", "triggers")).json();
      expect(list.triggers[0].source).toMatchObject({
        lastSyncStatus: "rate_limited",
        lastSyncError: "SUBSCRIPTION_RATE_LIMITED",
        syncRetryAt: new Date(reset * 1000).toISOString(),
      });
      expect(JSON.stringify(list)).not.toContain(credential);
      expect(JSON.stringify(list)).not.toContain("aes-256-gcm");
      const calls = rest.mock.calls.length;
      expect(await poll()).toBeNull();
      expect(rest).toHaveBeenCalledTimes(calls);
    } finally {
      rest.mockRestore();
      wake.mockRestore();
    }
  });

  it("denies foreign workspace reads and rejects webhook user, toolkit and wrong secrets", async () => {
    const { agent, conversation } = await fixture();
    const outsider = await db.user.create({
      data: {
        email: `automation-outsider-${stamp}@test.invalid`,
        passwordHash: "fixture",
      },
    });
    try {
      const token = (await createApiToken(outsider.id, "Outside workspace"))
        .token;
      for (const action of ["triggers", "usage", "targets"] as const) {
        const response = await handleAgentAutomation(
          new Request("http://localhost/api", {
            headers: { authorization: `Bearer ${token}` },
          }),
          agent.id,
          action,
        );
        expect(response.status).toBe(404);
      }
      const deniedWrite = await handleAgentAutomation(
        new Request("http://localhost/api", {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ monthlyUsd: 0 }),
        }),
        agent.id,
        "budget",
      );
      expect(deniedWrite.status).toBe(404);
      const secret = newTriggerSecret();
      const trigger = await db.agentTrigger.create({
        data: {
          workspaceId,
          agentId: agent.id,
          actorId: userId,
          kind: "webhook",
          name: "Webhook",
          prompt: "{{payload}}",
          secretHash: secret.secretHash,
        },
      });
      const userToken = (
        await createApiToken(userId, "User token is not a trigger secret")
      ).token;
      const toolkit = await db.toolkit.create({
        data: { workspaceId, name: "Token scope", slug: `automation-${stamp}` },
      });
      const toolkitToken = (
        await createApiToken(userId, "Toolkit token", { toolkitId: toolkit.id })
      ).token;
      const otherAgent = await fixture();
      const foreignWorkspace = await db.workspace.create({
        data: {
          ownerId: outsider.id,
          slug: `delivery-foreign-${stamp}`,
          name: "Foreign delivery",
        },
      });
      const foreignAgent = await db.agent.create({
        data: {
          workspaceId: foreignWorkspace.id,
          slug: "foreign",
          name: "Foreign",
          runtimeKind: "pi-sdk",
        },
      });
      const channel = async (
        channelWorkspaceId: string,
        channelAgentId: string,
      ) =>
        db.agentChannelConnection.create({
          data: {
            workspaceId: channelWorkspaceId,
            agentId: channelAgentId,
            platform: "telegram",
            name: "Delivery fixture",
            inboundTokenHash: randomUUID(),
            inboundTokenSecret: {},
            inboundTokenPrefix: "fixture",
          },
        });
      const foreignConnections = [
        await channel(workspaceId, otherAgent.agent.id),
        await channel(foreignWorkspace.id, foreignAgent.id),
      ];
      for (const connection of foreignConnections) {
        for (const method of ["POST", "PATCH"] as const) {
          const response = await handleAgentAutomation(
            new Request("http://localhost/api", {
              method,
              headers: {
                authorization: `Bearer ${userToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                ...(method === "POST"
                  ? {
                      kind: "webhook",
                      name: "Rejected delivery",
                      prompt: "Result",
                    }
                  : {}),
                delivery: {
                  connectionId: connection.id,
                  chatId: "raw:chat/id",
                },
              }),
            }),
            agent.id,
            method === "POST" ? "triggers" : "trigger",
            method === "PATCH" ? trigger.id : undefined,
          );
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({
            error: "INVALID_TRIGGER_DELIVERY",
          });
        }
      }
      const deliveryConnection = await channel(workspaceId, agent.id);
      await db.agentTrigger.update({
        where: { id: trigger.id },
        data: {
          lastConversationId: conversation.id,
          lastStatus: "running",
          deliveryConnectionId: deliveryConnection.id,
          deliveryChatId: "raw:chat/id",
        },
      });
      const admitted = await submitAgentEntry(
        {
          kind: "trigger",
          sourceId: trigger.id,
          conversationId: conversation.id,
          workspaceId,
          agentId: agent.id,
          actorId: userId,
          messageId: randomUUID(),
          text: "Delivery idempotency",
        },
        () => {},
      );
      const claimed = await claimTask(admitted.row.id);
      if (!claimed?.leaseToken) throw new Error("Missing trigger task lease");
      await finishTask(
        claimed.id,
        claimed.leaseToken,
        TaskState.TASK_STATE_FAILED,
        "PI_SDK_MODEL_FAILED",
      );
      const settledTask = await db.a2ATask.findUniqueOrThrow({
        where: { id: claimed.id },
      });
      await settleAgentTriggerTask(settledTask);
      await vi.waitFor(async () => {
        expect(
          await db.agentTrigger.findUniqueOrThrow({
            where: { id: trigger.id },
          }),
        ).toMatchObject({
          lastStatus: "failed",
          lastDeliveryStatus: "pending",
          lastDeliveryError: null,
          lastDeliveryText: 'Trigger "Webhook" failed (PI_SDK_MODEL_FAILED).',
        });
      });
      const { lastDeliveryAt: queuedAt } =
        await db.agentTrigger.findUniqueOrThrow({ where: { id: trigger.id } });
      // Advance only Date so a re-queue would stamp a distinctly later lastDeliveryAt.
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_000 });
      try {
        await settleAgentTriggerTask(settledTask);
      } finally {
        vi.useRealTimers();
      }
      await deliverPendingTrigger(trigger.id);
      // Settlement also starts a background attempt; without a runner each attempt returns to pending.
      await vi.waitFor(async () => {
        expect(
          await db.agentTrigger.findUniqueOrThrow({
            where: { id: trigger.id },
          }),
        ).toMatchObject({
          lastStatus: "failed",
          lastDeliveryStatus: "pending",
          lastDeliveryError: null,
          lastDeliveryAt: queuedAt,
        });
      });
      expect(
        await db.message.count({
          where: { id: `trigger-result-${claimed.id}` },
        }),
      ).toBe(1);
      for (const bearer of ["wrong-secret", userToken, toolkitToken]) {
        const response = await handleTriggerWebhook(
          new Request("http://localhost/api", {
            method: "POST",
            headers: {
              authorization: `Bearer ${bearer}`,
              "content-type": "application/json",
            },
            body: "{}",
          }),
          trigger.id,
        );
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "Unauthorized" });
      }
    } finally {
      await db.workspace.deleteMany({ where: { ownerId: outsider.id } });
      await db.user.delete({ where: { id: outsider.id } });
    }
  });
  it("uses a workspace override grant without changing the immutable revision or subsequent default", async () => {
    const { agent, sandbox, revision, conversation } = await fixture();
    const alternate = await db.modelProvider.create({
      data: {
        workspaceId,
        name: "Alternate",
        format: "openai-responses",
        baseUrl: "https://alternate.test.invalid",
        apiKey: "alternate-private-key",
        models: ["alternate"],
      },
    });
    await db.conversation.update({
      where: { id: conversation.id },
      data: { sandboxId: sandbox.id },
    });
    const override = { providerId: alternate.id, model: "alternate" };
    const resolved = await resolveAgentModelOverride(
      workspaceId,
      override,
      "pi-sdk",
    );
    expect(resolved).toMatchObject({
      provider: { id: alternate.id },
      model: "alternate",
    });
    const token = {
      workspaceId,
      agentId: agent.id,
      agentRevisionId: revision.id,
      sandboxId: sandbox.id,
      conversationId: conversation.id,
      providerId: alternate.id,
      modelOverride: override,
      deploymentIds: [],
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    await expect(isAgentRuntimeGrantCurrent(token)).resolves.toBe(true);
    await expect(
      isAgentRuntimeGrantCurrent({ ...token, providerId }),
    ).resolves.toBe(false);
    await expect(
      isAgentRuntimeGrantCurrent({ ...token, modelOverride: undefined }),
    ).resolves.toBe(false);
    const live = await getAgentForRun(agent.id, workspaceId);
    if (!live) throw new Error("Missing Agent fixture");
    expect(await resolvePinnedAgent(live, revision.id)).toMatchObject({
      providerId,
      model: "original",
    });
    await expect(
      isAgentRuntimeGrantCurrent({
        ...token,
        providerId,
        modelOverride: undefined,
      }),
    ).resolves.toBe(true);
    expect(
      await db.agentRevision.findUniqueOrThrow({ where: { id: revision.id } }),
    ).toMatchObject({ config: revision.config });
    expect(await db.agentRevision.count({ where: { agentId: agent.id } })).toBe(
      1,
    );
    expect(
      await db.agent.findUniqueOrThrow({ where: { id: agent.id } }),
    ).toMatchObject({ providerId, model: "original" });
    await db.modelProvider.update({
      where: { id: alternate.id },
      data: { models: [] },
    });
    await expect(isAgentRuntimeGrantCurrent(token)).resolves.toBe(false);
    await db.modelProvider.update({
      where: { id: alternate.id },
      data: { models: ["alternate"], apiKey: "" },
    });
    await expect(isAgentRuntimeGrantCurrent(token)).resolves.toBe(false);
  });

  it("rejects foreign providers, unknown models, missing credentials and unsupported runtime formats", async () => {
    const foreign = await db.workspace.create({
      data: { ownerId: userId, slug: `foreign-${stamp}`, name: "Foreign" },
    });
    try {
      const provider = await db.modelProvider.create({
        data: {
          workspaceId: foreign.id,
          name: "Foreign",
          format: "openai",
          baseUrl: "https://foreign.test.invalid",
          apiKey: "private",
          models: ["foreign"],
        },
      });
      await expect(
        resolveAgentModelOverride(
          workspaceId,
          {
            providerId: provider.id,
            model: "foreign",
          },
          "pi-sdk",
        ),
      ).rejects.toMatchObject({ code: "modelOverrideUnavailable" });
      await expect(
        resolveAgentModelOverride(
          workspaceId,
          {
            providerId,
            model: "not-in-catalog",
          },
          "pi-sdk",
        ),
      ).rejects.toMatchObject({ code: "modelOverrideUnavailable" });
      const unavailable = await db.modelProvider.create({
        data: {
          workspaceId,
          name: "No credentials",
          format: "openai",
          baseUrl: "https://unavailable.test.invalid",
          apiKey: " ",
          models: ["unavailable"],
        },
      });
      await expect(
        resolveAgentModelOverride(
          workspaceId,
          {
            providerId: unavailable.id,
            model: "unavailable",
          },
          "pi-sdk",
        ),
      ).rejects.toMatchObject({ code: "modelOverrideUnavailable" });
      await db.modelProvider.update({
        where: { id: unavailable.id },
        data: { apiKey: "private", format: "unsupported" },
      });
      await expect(
        resolveAgentModelOverride(
          workspaceId,
          {
            providerId: unavailable.id,
            model: "unavailable",
          },
          "pi-sdk",
        ),
      ).rejects.toMatchObject({ code: "modelOverrideUnavailable" });
    } finally {
      await db.workspace.delete({ where: { id: foreign.id } });
    }
  });

  it("parses only an explicit well-formed per-turn model override", () => {
    expect(
      parseAgentChatBody({
        messages: [],
        modelOverride: { providerId, model: "future" },
      })?.modelOverride,
    ).toEqual({ providerId, model: "future" });
    expect(parseAgentChatBody({ messages: [] })?.modelOverride).toBeUndefined();
    expect(
      parseAgentChatBody({
        messages: [],
        modelOverride: { providerId, model: "" },
      }),
    ).toBeNull();
    expect(
      parseAgentChatBody({
        messages: [],
        modelOverride: { providerId, model: "future", apiKey: "untrusted" },
      }),
    ).toBeNull();
  });
  it("keeps resource requests and metadata on the session revision after a new publication", async () => {
    const { agent, revision, conversation } = await fixture();
    expect(conversation).toMatchObject({
      agentRevisionId: revision.id,
      legacyRevisionUnresolved: false,
    });
    await db.agent.update({
      where: { id: agent.id },
      data: { model: "future", systemPrompt: "Future prompt" },
    });
    const future = await publishFixtureAgentRevision(workspaceId, agent.id);
    const live = await getAgentForRun(agent.id, workspaceId);
    if (!live) throw new Error("Missing Agent fixture");
    const resolved = await resolveAgentRequestSession(live, {
      conversationId: conversation.id,
    });
    expect(resolved.agent).toMatchObject({
      agentRevisionId: revision.id,
      model: "original",
      systemPrompt: "Original prompt",
    });
    expect(resolved.mcpContext.agentRevisionId).toBe(revision.id);
    const view = await getConversation(conversation.id, workspaceId);
    expect(view).toMatchObject({
      readOnly: false,
      agentRevisionId: revision.id,
      runtimeKind: "pi-sdk",
      modelName: "original",
      contextWindow: null,
      contextWindowEstimated: null,
      boundSandbox: null,
    });
    expect(
      (await createConversation(workspaceId, agent.id))?.agentRevisionId,
    ).toBe(future.id);
  });
  it("keeps unresolved history readable without selecting a current revision or template", async () => {
    const { agent } = await fixture();
    const history = await db.conversation.create({
      data: {
        agentId: agent.id,
        messages: {
          create: {
            role: "assistant",
            parts: [{ type: "text", text: "Retained history" }],
          },
        },
      },
    });
    const view = await getConversation(history.id, workspaceId);
    expect(view).toMatchObject({
      readOnly: true,
      agentRevisionId: null,
      legacyRevisionUnresolved: true,
      runtimeKind: null,
      modelName: null,
      boundSandbox: null,
    });
    expect(view?.messages).toHaveLength(1);
    const live = await getAgentForRun(agent.id, workspaceId);
    if (!live) throw new Error("Missing Agent fixture");
    await expect(
      resolveAgentRequestSession(live, { conversationId: history.id }),
    ).rejects.toMatchObject({ status: 410 });
  });
  it("rejects mismatched Work and Conversation pins rather than repinning either record", async () => {
    const { agent, revision, conversation } = await fixture();
    await db.agent.update({
      where: { id: agent.id },
      data: { model: "future" },
    });
    const future = await publishFixtureAgentRevision(workspaceId, agent.id);
    expect(future.id).not.toBe(revision.id);
    const work = await db.workSession.create({
      data: {
        workspaceId,
        agentId: agent.id,
        conversationId: conversation.id,
        agentRevisionId: future.id,
        legacyRevisionUnresolved: false,
        runtimeKind: "pi-sdk",
        runtimeSnapshot: {},
        task: "Mismatched session",
      },
    });
    try {
      const live = await getAgentForRun(agent.id, workspaceId);
      if (!live) throw new Error("Missing Agent fixture");
      await expect(
        resolveAgentRequestSession(live, { workSessionId: work.id }),
      ).rejects.toMatchObject({ status: 410 });
      expect(await getConversation(conversation.id, workspaceId)).toMatchObject(
        { readOnly: true, agentRevisionId: revision.id },
      );
      expect(
        await db.workSession.findUniqueOrThrow({ where: { id: work.id } }),
      ).toMatchObject({ agentRevisionId: future.id });
    } finally {
      await db.workSession.delete({ where: { id: work.id } });
    }
  });
  it("rechecks live provider authorization against the exact persisted sandbox and revision", async () => {
    const { agent, sandbox, revision, conversation } = await fixture();
    await db.conversation.update({
      where: { id: conversation.id },
      data: { sandboxId: sandbox.id },
    });
    const token = {
      workspaceId,
      agentId: agent.id,
      agentRevisionId: revision.id,
      sandboxId: sandbox.id,
      conversationId: conversation.id,
      providerId,
      deploymentIds: [],
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    await expect(isAgentRuntimeGrantCurrent(token)).resolves.toBe(true);
    await expect(
      isAgentRuntimeGrantCurrent({ ...token, sandboxId: "another-sandbox" }),
    ).resolves.toBe(false);
    await db.agent.update({
      where: { id: agent.id },
      data: { providerId: null },
    });
    await expect(isAgentRuntimeGrantCurrent(token)).resolves.toBe(true);
    const provider = await db.modelProvider.findUniqueOrThrow({
      where: { id: providerId },
      select: { apiKey: true },
    });
    await db.modelProvider.update({
      where: { id: providerId },
      data: { apiKey: " " },
    });
    try {
      await expect(isAgentRuntimeGrantCurrent(token)).resolves.toBe(false);
      await expect(resolvePinnedAgent(agent, revision.id)).rejects.toThrow(
        "AGENT_PROVIDER_REVOKED",
      );
    } finally {
      await db.modelProvider.update({
        where: { id: providerId },
        data: { apiKey: provider.apiKey },
      });
    }
    expect(
      await db.conversation.findUnique({ where: { id: conversation.id } }),
    ).toMatchObject({ agentRevisionId: revision.id, sandboxId: sandbox.id });
  });
  it("keeps distinct immutable session grants valid on one compatible environment and revokes archived or incompatible mappings", async () => {
    const { agent, sandbox, revision, conversation } = await fixture();
    const sharedConfig = {
      managedBy: "agent-conversation",
      scope: "agent",
      agentId: agent.id,
      sourceSandboxId: "revision",
      agentRevisionId: revision.id,
    };
    await db.sandbox.update({
      where: { id: sandbox.id },
      data: { config: sharedConfig },
    });
    await db.conversation.update({
      where: { id: conversation.id },
      data: { sandboxId: sandbox.id },
    });
    await db.agent.update({
      where: { id: agent.id },
      data: { systemPrompt: "A separate revision" },
    });
    const future = await publishFixtureAgentRevision(workspaceId, agent.id);
    const second = await createConversation(workspaceId, agent.id);
    if (!second) throw new Error("Missing shared conversation fixture");
    await db.conversation.update({
      where: { id: second.id },
      data: { sandboxId: sandbox.id },
    });
    const token = {
      workspaceId,
      agentId: agent.id,
      agentRevisionId: revision.id,
      sandboxId: sandbox.id,
      conversationId: conversation.id,
      providerId,
      deploymentIds: [],
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    const secondToken = {
      ...token,
      conversationId: second.id,
      agentRevisionId: future.id,
    };
    expect(await isAgentRuntimeGrantCurrent(token)).toBe(true);
    expect(await isAgentRuntimeGrantCurrent(secondToken)).toBe(true);
    expect(
      await isAgentRuntimeGrantCurrent({ ...token, conversationId: second.id }),
    ).toBe(false);
    await db.sandbox.update({
      where: { id: sandbox.id },
      data: {
        config: { ...sharedConfig, pendingWorkspaceDeletes: [conversation.id] },
      },
    });
    expect(await isAgentRuntimeGrantCurrent(token)).toBe(false);
    expect(await isAgentRuntimeGrantCurrent(secondToken)).toBe(true);
    await db.sandbox.update({
      where: { id: sandbox.id },
      data: { config: { ...sharedConfig, readOnly: true } },
    });
    expect(await isAgentRuntimeGrantCurrent(token)).toBe(false);
    expect(await isAgentRuntimeGrantCurrent(secondToken)).toBe(false);
    const environment = await db.agentRevision.create({
      data: {
        agentId: agent.id,
        version: future.version + 1,
        config: {
          ...future.config,
          environment: { ...future.config.environment, network: "none" },
        },
      },
    });
    await db.sandbox.update({
      where: { id: sandbox.id },
      data: { config: { ...sharedConfig, agentRevisionId: environment.id } },
    });
    expect(await isAgentRuntimeGrantCurrent(token)).toBe(false);
    expect(await isAgentRuntimeGrantCurrent(secondToken)).toBe(false);
  });
  it.each(["shell_exec", "write_file", "delete_file"])(
    "denies historical %s without starting any runtime",
    async (name) => {
      const response = await serveHistoricalSandboxFiles(
        new Request("http://toolplane.test/sandbox/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: { path: "history.txt" } },
          }),
        }),
        ["rpc"],
        null,
      );
      expect(response.status).toBe(410);
    },
  );
});
