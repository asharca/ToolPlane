// @vitest-environment node
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TaskState } from "@a2a-js/sdk";
import { db } from "@/lib/db";
import { createApiToken } from "@/lib/auth/tokens";
import { claimTask, finishTask } from "@/lib/a2a/store";
import {
  handleAgentAutomation,
  handleTriggerWebhook,
} from "@/lib/agents/automation-http";
import { settleAgentTriggerTask } from "@/lib/agents/triggers";
import { publishFixtureAgentRevision } from "./agent-revision-fixture";
import type * as WorkerModule from "@/lib/agents/execution/worker";

// Admission is under test; task execution is driven explicitly below.
vi.mock("@/lib/agents/execution/worker", async (original) => ({
  ...(await original<typeof WorkerModule>()),
  wakeAgentWorker: vi.fn(),
}));

const stamp = randomUUID();
let userId = "";
let workspaceId = "";
let agentId = "";
let token = "";

beforeAll(async () => {
  const user = await db.user.create({
    data: {
      email: `trigger-webhooks-${stamp}@test.invalid`,
      passwordHash: "x",
    },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      ownerId: userId,
      slug: `trigger-webhooks-${stamp}`,
      name: "Trigger webhooks",
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
      models: ["original"],
    },
  });
  const deployment = await db.deployment.create({
    data: { workspaceId, source: "sandbox", status: "stopped" },
  });
  const sandbox = await db.sandbox.create({
    data: {
      workspaceId,
      deploymentId: deployment.id,
      name: "webhooks",
      slug: "webhooks",
      kind: "docker",
      network: "isolated",
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: "webhooks",
      slug: "webhooks",
      runtimeKind: "pi-sdk",
      providerId: provider.id,
      model: "original",
      systemPrompt: "Fixture",
      sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } },
    },
  });
  agentId = agent.id;
  await publishFixtureAgentRevision(workspaceId, agent.id);
  token = (await createApiToken(userId, "Trigger webhooks")).token;
});

afterAll(async () => {
  if (workspaceId) {
    await db.a2AContext.deleteMany({ where: { workspaceId } });
    await db.conversation.deleteMany({ where: { agent: { workspaceId } } });
    await db.workspace.delete({ where: { id: workspaceId } });
  }
  if (userId) await db.user.delete({ where: { id: userId } });
});

async function createTrigger(webhook: unknown) {
  const response = await handleAgentAutomation(
    new Request("http://localhost/api", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "webhook",
        name: "Webhook",
        prompt: "{{event}} {{payload}}",
        webhook,
      }),
    }),
    agentId,
    "triggers",
  );
  expect(response.status).toBe(201);
  return (await response.json()) as {
    trigger: {
      id: string;
      webhook: { auth: string; ignoredSenders: string[] };
    };
    secret: string;
  };
}

function github(
  triggerId: string,
  secret: string,
  event: string,
  delivery: string,
  payload: unknown,
  signature?: string,
) {
  const body = JSON.stringify(payload);
  return handleTriggerWebhook(
    new Request("http://localhost/api", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-hub-signature-256":
          signature ??
          `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body,
    }),
    triggerId,
  );
}

const issue = (number: number, login = "reporter", type = "User") => ({
  action: "opened",
  repository: { full_name: "acme/app" },
  sender: { login, type },
  issue: {
    number,
    title: `Crash ${number}`,
    body: "x".repeat(50_000),
    user: { login },
  },
});

async function settle(taskId: string, state: TaskState) {
  const claimed = await claimTask(taskId);
  if (!claimed?.leaseToken) throw new Error("Missing task lease");
  await finishTask(claimed.id, claimed.leaseToken, state, "fixture");
  await settleAgentTriggerTask(
    await db.a2ATask.findUniqueOrThrow({ where: { id: taskId } }),
  );
}

describe.sequential("signed trigger webhooks", () => {
  it("verifies GitHub signatures, deduplicates deliveries and serializes one conversation per issue", async () => {
    const { trigger, secret } = await createTrigger({
      auth: "github",
      ignoredSenders: ["Robo-Bot"],
    });
    expect(trigger.webhook).toMatchObject({
      auth: "github",
      ignoredSenders: ["robo-bot"],
    });
    const stored = await db.agentTrigger.findUniqueOrThrow({
      where: { id: trigger.id },
    });
    expect(stored.secretHash).toBeNull();
    expect(JSON.stringify(stored.webhookSecret)).not.toContain(secret);

    for (const signature of [`sha256=${"0".repeat(64)}`, "", undefined]) {
      const denied =
        signature === undefined
          ? await github(trigger.id, "wrong-secret", "issues", "d0", issue(7))
          : await github(
              trigger.id,
              secret,
              "issues",
              "d0",
              issue(7),
              signature,
            );
      expect(denied.status).toBe(401);
    }
    // A GitHub-mode trigger does not accept its secret as a bearer token.
    const bearer = await handleTriggerWebhook(
      new Request("http://localhost/api", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
        body: "{}",
      }),
      trigger.id,
    );
    expect(bearer.status).toBe(401);

    const ping = await github(trigger.id, secret, "ping", "p1", { zen: "x" });
    expect(await ping.json()).toEqual({
      status: "ignored",
      conversationId: null,
    });
    for (const [login, type] of [
      ["dependabot[bot]", "Bot"],
      ["ROBO-BOT", "User"],
    ]) {
      const ignored = await github(
        trigger.id,
        secret,
        "issues",
        randomUUID(),
        issue(7, login, type),
      );
      expect(await ignored.json()).toEqual({
        status: "ignored",
        conversationId: null,
      });
    }
    expect(
      await db.agentTriggerEvent.count({ where: { triggerId: trigger.id } }),
    ).toBe(0);

    const first = await github(trigger.id, secret, "issues", "d1", issue(7));
    expect(first.status).toBe(202);
    const opened = (await first.json()) as {
      status: string;
      conversationId: string;
    };
    expect(opened.status).toBe("running");
    const replay = await github(trigger.id, secret, "issues", "d1", issue(7));
    expect(await replay.json()).toEqual({
      status: "duplicate",
      conversationId: opened.conversationId,
    });

    const comment = await github(trigger.id, secret, "issue_comment", "d2", {
      ...issue(7),
      action: "created",
      comment: { body: "still broken", user: { login: "reporter" } },
    });
    expect(await comment.json()).toEqual({
      status: "queued",
      conversationId: null,
    });
    const other = (await (
      await github(trigger.id, secret, "issues", "d3", issue(8))
    ).json()) as { status: string; conversationId: string };
    expect(other.status).toBe("running");
    expect(other.conversationId).not.toBe(opened.conversationId);

    const firstEvent = await db.agentTriggerEvent.findUniqueOrThrow({
      where: {
        triggerId_dedupeKey: { triggerId: trigger.id, dedupeKey: "github:d1" },
      },
    });
    if (!firstEvent.taskId) throw new Error("Missing first task");
    const firstMessage = await db.message.findFirstOrThrow({
      where: { conversationId: opened.conversationId, role: "user" },
    });
    const prompt = JSON.stringify(firstMessage.parts);
    expect(prompt).toContain("issues");
    expect(prompt).toContain("Crash 7");
    expect(prompt.length).toBeLessThan(20_000);

    await settle(firstEvent.taskId, TaskState.TASK_STATE_COMPLETED);
    const queued = await db.agentTriggerEvent.findUniqueOrThrow({
      where: {
        triggerId_dedupeKey: { triggerId: trigger.id, dedupeKey: "github:d2" },
      },
    });
    expect(queued).toMatchObject({
      status: "running",
      conversationId: opened.conversationId,
    });
    if (!queued.taskId) throw new Error("Missing follow-up task");
    const [previous, followUp] = await Promise.all([
      db.a2ATask.findUniqueOrThrow({ where: { id: firstEvent.taskId } }),
      db.a2ATask.findUniqueOrThrow({ where: { id: queued.taskId } }),
    ]);
    // The follow-up continues the native context of the issue's first turn.
    expect(followUp.contextId).toBe(previous.contextId);
    expect(
      await db.agentTriggerEvent.findUniqueOrThrow({
        where: { id: firstEvent.id },
      }),
    ).toMatchObject({ status: "done" });

    // Deleting the conversation ends the thread; the next event starts fresh.
    await settle(queued.taskId, TaskState.TASK_STATE_FAILED);
    expect(
      await db.agentTriggerEvent.findUniqueOrThrow({
        where: { id: queued.id },
      }),
    ).toMatchObject({ status: "failed" });
    await db.conversation.delete({ where: { id: opened.conversationId } });
    const reopened = (await (
      await github(trigger.id, secret, "issues", "d4", issue(7))
    ).json()) as { status: string; conversationId: string };
    expect(reopened.status).toBe("running");
    expect(reopened.conversationId).not.toBe(opened.conversationId);
  });

  it("threads bearer webhooks by header and switches auth with a new secret", async () => {
    const { trigger, secret } = await createTrigger(undefined);
    expect(trigger.webhook.auth).toBe("bearer");
    const send = (headers: Record<string, string>, bearer = secret) =>
      handleTriggerWebhook(
        new Request("http://localhost/api", {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, ...headers },
          body: JSON.stringify({ n: 1 }),
        }),
        trigger.id,
      ).then((response) => response.json());
    const first = await send({
      "x-toolplane-thread-key": "order-1",
      "idempotency-key": "k1",
    });
    expect(first.status).toBe("running");
    expect(
      await send({
        "x-toolplane-thread-key": "order-1",
        "idempotency-key": "k1",
      }),
    ).toEqual({
      status: "duplicate",
      conversationId: first.conversationId,
    });
    expect((await send({ "x-toolplane-thread-key": "order-1" })).status).toBe(
      "queued",
    );
    const unthreaded = await send({});
    expect(unthreaded.status).toBe("running");
    expect(unthreaded.conversationId).not.toBe(first.conversationId);

    const patched = await handleAgentAutomation(
      new Request("http://localhost/api", {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ webhook: { auth: "github" } }),
      }),
      agentId,
      "trigger",
      trigger.id,
    );
    const body = (await patched.json()) as { secret?: string };
    expect(body.secret).toMatch(/^tpt_/);
    expect(body.secret).not.toBe(secret);
    expect((await send({})).error).toBe("Unauthorized");
  });
});
