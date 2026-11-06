// @vitest-environment node
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SendMessageRequest,
  Task,
  Message,
  Role,
  TaskState,
} from "@a2a-js/sdk";
import {
  submitTask,
  requestCancellation,
  claimTask,
  recordLocalPromptInvocation,
} from "@/lib/a2a/store";
import { db } from "@/lib/db";
import {
  publishAgentRevision,
  requireAgentRevision,
  resolvePinnedAgent,
  rollbackAgentRevision,
} from "@/lib/agents/revisions";
import { getAgentForRun } from "@/lib/agents/queries";
import {
  createWorkSession,
  appendWorkSessionInput,
  resumeWorkSession,
} from "@/lib/work/sessions";
import { createLocalRootGrant, assertLocalGrant } from "@/lib/a2a/local-policy";
import { intersectCollaborationPolicy } from "@/lib/a2a/collaboration-policy";
import type {
  AgentA2APolicy,
  AgentRevisionConfig,
} from "@/lib/agents/revision-types";
import {
  agentEntryPromptInvocations,
  submitAgentEntry,
} from "@/lib/agents/execution/entries";
import { agentMessageModelOverride } from "@/lib/agents/turn-model";
import {
  withWorkUiLease,
  handleSessionUi,
  handleWorkUi,
} from "@/lib/agents/execution/work-ui";
import { createAgentRuntimeToken } from "@/lib/agents/runtime-access";
import { updateTaskUi } from "@/lib/agents/execution/task-ui";
import { mapTaskSandbox } from "./task-sandbox-fixture";
import { withAgentMaintenanceLease } from "@/lib/agents/agent-execution-gate";
const browserActor = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestPrincipal: async () => ({
    credential: "session",
    user: { id: browserActor.id },
  }),
}));

const stamp = randomUUID();
let userId = "";
let workspaceId = "";
let providerId = "";
let sequence = 0;
beforeAll(async () => {
  const user = await db.user.create({
    data: {
      email: `work-revision-${stamp}@test.invalid`,
      passwordHash: "fixture",
    },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      ownerId: userId,
      slug: `work-revision-${stamp}`,
      name: "Revision regression",
      members: { create: { userId, role: "owner" } },
    },
  });
  workspaceId = workspace.id;
  const provider = await db.modelProvider.create({
    data: {
      workspaceId,
      name: "Fixture",
      format: "openai",
      baseUrl: "https://model.test.invalid",
      apiKey: "fixture",
      models: ["fixture"],
    },
  });
  providerId = provider.id;
});
afterAll(async () => {
  if (workspaceId) {
    await db.workSession.deleteMany({ where: { workspaceId } });
    await db.conversation.deleteMany({ where: { agent: { workspaceId } } });
    await db.a2AContext.deleteMany({ where: { workspaceId } });
    await db.workspace.delete({ where: { id: workspaceId } });
  }
  if (userId) await db.user.delete({ where: { id: userId } });
});
async function fixture() {
  const slug = `revision-${++sequence}`;
  const deployment = await db.deployment.create({
    data: { workspaceId, source: "config" },
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
      model: "fixture",
      a2aInboundEnabled: true,
      a2aInternalEnabled: true,
      sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } },
    },
  });
  const config: AgentRevisionConfig = {
    schemaVersion: 1,
    runtimeKind: "pi-sdk",
    systemPrompt: "approved prompt",
    providerId,
    model: "fixture",
    modelProviderIds: [],
    maxSteps: 10,
    disabledBuiltinTools: [],
    sandboxTemplateId: sandbox.id,
    externalSandboxes: [],
    environment: {
      kind: "docker",
      image: `fixture@sha256:${"a".repeat(64)}`,
      network: "isolated",
      piVersion: "0.87.1",
      initialSnapshot: null,
      resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
      credentialReferences: [],
    },
    skills: [],
    knowledgeBaseIds: [],
    packages: [],
    mcpGrants: [],
    a2a: {
      inboundEnabled: true,
      outboundEnabled: false,
      policy: { schemaVersion: 1, targets: [] },
    },
  };
  const revision = await publishAgentRevision(workspaceId, agent.id, {
    expectedRevisionId: null,
    config,
  });
  return { agent, config, revision };
}
describe.sequential("Work and local A2A owner revisions", () => {
  it("rejects retry and new input while conversation deletion holds maintenance", async () => {
    const { agent } = await fixture();
    const work = await createWorkSession({
      workspaceId,
      agentId: agent.id,
      task: "Deletion admission race",
    });
    if (!work) throw new Error("Missing Work fixture");
    await db.workSession.update({
      where: { id: work.id },
      data: { status: "failed" },
    });
    const requester = new AsyncResource("concurrent-work-input");
    try {
      await withAgentMaintenanceLease(agent.id, () =>
        requester.runInAsyncScope(async () => {
          await expect(
            resumeWorkSession(workspaceId, work.id),
          ).resolves.toMatchObject({
            ok: false,
            reason: "invalid_transition",
            status: "failed",
          });
          await expect(
            appendWorkSessionInput(workspaceId, work.id, "Concurrent input"),
          ).resolves.toMatchObject({
            ok: false,
            reason: "invalid_transition",
            status: "failed",
          });
        }),
      );
    } finally {
      requester.emitDestroy();
    }
    expect(
      await db.workSession.findUnique({ where: { id: work.id } }),
    ).toMatchObject({ status: "failed" });
    expect(
      await db.message.count({
        where: { conversationId: work.conversationId },
      }),
    ).toBe(1);
  });
  it("persists native Work todos and scopes dialogs to the live turn and initiating browser actor", async () => {
    const { agent, revision } = await fixture();
    const work = await createWorkSession({
      workspaceId,
      agentId: agent.id,
      a2aActorId: userId,
      task: "Native Work UI",
    });
    if (!work?.sandboxId) throw new Error("Missing Work fixture");
    browserActor.id = userId;
    await db.workSession.update({
      where: { id: work.id },
      data: { status: "running" },
    });
    await db.conversation.update({
      where: { id: work.conversationId },
      data: { sandboxId: work.sandboxId },
    });
    const scope = {
      conversationId: work.conversationId,
      workspaceId,
      agentId: agent.id,
      agentRevisionId: revision.id,
    };
    const claims = {
      ...scope,
      sandboxId: work.sandboxId,
      providerId,
      deploymentIds: [],
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    const token = await createAgentRuntimeToken(claims);
    const runtime = (body: unknown, credential = token) =>
      handleSessionUi(
        new Request("http://localhost:3000/api/v1/agent-runtime/sessions/ui", {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );
    const slug = `work-revision-${stamp}`;
    const url = `http://localhost:3000/api/v1/workspaces/${slug}/work-sessions/${work.id}/ui`;
    const view = (body?: unknown, extra: Record<string, string> = {}) =>
      handleWorkUi(
        new Request(url, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            host: "localhost:3000",
            ...(body === undefined
              ? {}
              : {
                  origin: "http://localhost:3000",
                  "content-type": "application/json",
                }),
            ...extra,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        slug,
        work.id,
      );
    const request = {
      type: "extension_ui_request",
      id: randomUUID(),
      method: "confirm",
      title: "Native confirm",
      message: "Continue?",
    };
    const response = {
      type: "extension_ui_response",
      id: request.id,
      confirmed: true,
    };
    const todos = [{ id: 1, text: "Native Work todo", done: false }];
    await withWorkUiLease(scope, token, async (enabled) => {
      expect(enabled).toBe(true);
      expect((await runtime({ action: "todos", todos })).status).toBe(200);
      expect((await runtime({ action: "request", request })).status).toBe(200);
      expect((await (await view()).json()).execution).toMatchObject({
        status: "input-required",
        uiRequests: [request],
        todos,
      });
      expect(
        (await view(response, { origin: "https://evil.example" })).status,
      ).toBe(403);
      expect(
        (await view(response, { authorization: "Bearer unrelated" })).status,
      ).toBe(401);
      expect((await view({ ...response, taskId: "forged" })).status).toBe(400);
      const foreign = await db.user.create({
        data: {
          email: `work-ui-${randomUUID()}@test.invalid`,
          passwordHash: "fixture",
        },
      });
      try {
        await db.membership.create({
          data: { workspaceId, userId: foreign.id, role: "member" },
        });
        browserActor.id = foreign.id;
        expect((await view()).status).toBe(404);
        expect((await view(response)).status).toBe(404);
      } finally {
        browserActor.id = userId;
        await db.membership.deleteMany({ where: { userId: foreign.id } });
        await db.user.delete({ where: { id: foreign.id } });
      }
      expect((await view(response)).status).toBe(200);
      expect((await view(response)).status).toBe(409);
      expect(
        await (await runtime({ action: "poll", id: request.id })).json(),
      ).toEqual({ response });
      const stale = await createAgentRuntimeToken({
        ...claims,
        exp: claims.exp + 1,
      });
      expect(
        (await runtime({ action: "todos", todos: [] }, stale)).status,
      ).toBe(404);
      expect(
        (
          await runtime({
            action: "todos",
            todos: [{ id: 2, text: "x".repeat(270_000), done: false }],
          })
        ).status,
      ).toBe(413);
      expect((await (await view()).json()).execution.todos).toEqual(todos);
    });
    expect((await runtime({ action: "todos", todos: [] })).status).toBe(404);
    await db.workSession.update({
      where: { id: work.id },
      data: { status: "completed" },
    });
    expect((await (await view()).json()).execution).toMatchObject({
      status: "completed",
      uiRequests: [],
      todos,
    });
  });
  it("answers admitted Work dialogs through the current task lease and rejects stale replies", async () => {
    const { agent, revision } = await fixture();
    const work = await createWorkSession({
      workspaceId,
      agentId: agent.id,
      a2aActorId: userId,
      task: "Task-backed Work UI",
    });
    if (!work) throw new Error("Missing Work fixture");
    browserActor.id = userId;
    await db.workSession.update({
      where: { id: work.id },
      data: { status: "running" },
    });
    const accepted = await submitAgentEntry(
      {
        kind: "work",
        sourceId: work.id,
        workspaceId,
        agentId: agent.id,
        actorId: userId,
        messageId: randomUUID(),
        text: "Task-backed Work UI",
      },
      () => {},
    );
    const task = await claimTask(accepted.row.id);
    if (!task?.leaseToken) throw new Error("Missing Work task claim");
    const mapping = await mapTaskSandbox(task);
    await db.workSession.update({
      where: { id: work.id },
      data: { sandboxId: mapping.sandboxId },
    });
    const token = {
      workspaceId,
      agentId: agent.id,
      agentRevisionId: revision.id,
      providerId,
      sandboxId: mapping.sandboxId,
      conversationId: work.conversationId,
      a2aContextId: task.contextId,
      a2aTaskId: task.id,
      a2aLeaseToken: task.leaseToken,
      deploymentIds: [],
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    const request = {
      type: "extension_ui_request" as const,
      id: randomUUID(),
      method: "confirm" as const,
      title: "Work task confirm",
      message: "Continue?",
    };
    await updateTaskUi(token, { action: "request", request });
    const slug = `work-revision-${stamp}`;
    const url = `http://localhost:3000/api/v1/workspaces/${slug}/work-sessions/${work.id}/ui`;
    const view = (body?: unknown) =>
      handleWorkUi(
        new Request(url, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            host: "localhost:3000",
            ...(body === undefined
              ? {}
              : {
                  origin: "http://localhost:3000",
                  "content-type": "application/json",
                }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        slug,
        work.id,
      );
    expect((await (await view()).json()).execution).toMatchObject({
      status: "input-required",
      uiRequests: [request],
    });
    const response = {
      type: "extension_ui_response",
      id: request.id,
      confirmed: true,
    };
    expect((await view(response)).status).toBe(200);
    expect(
      await updateTaskUi(token, { action: "poll", id: request.id }),
    ).toEqual({ response });
    expect((await view(response)).status).toBe(409);
    await updateTaskUi(token, { action: "resolve", id: request.id });
    await updateTaskUi(token, {
      action: "request",
      request: { ...request, id: "stale-dialog" },
    });
    await db.a2ATask.update({
      where: { id: task.id },
      data: {
        leaseToken: randomUUID(),
        state: TaskState.TASK_STATE_WORKING,
      },
    });
    expect((await view({ ...response, id: "stale-dialog" })).status).toBe(404);
    expect((await (await view()).json()).execution.uiRequests).toEqual([]);
  });
  it("stores a Work override only on its user turn and keeps the pinned runtime snapshot unchanged", async () => {
    const { agent, revision } = await fixture();
    const alternate = await db.modelProvider.create({
      data: {
        workspaceId,
        name: "Alternate",
        format: "openai",
        baseUrl: "https://alternate.test.invalid",
        apiKey: "private-alternate-key",
        models: ["alternate"],
      },
    });
    const override = { providerId: alternate.id, model: "alternate" };
    const work = await createWorkSession({
      workspaceId,
      agentId: agent.id,
      task: "Override first turn",
      modelOverride: override,
    });
    if (!work) throw new Error("Missing Work fixture");
    const first = await db.message.findFirstOrThrow({
      where: { conversationId: work.conversationId, role: "user" },
    });
    expect(agentMessageModelOverride(first.parts)).toEqual(override);
    expect(work.runtimeSnapshot).toMatchObject({
      providerId,
      model: "fixture",
    });
    await db.workSession.update({
      where: { id: work.id },
      data: { status: "idle" },
    });
    await expect(
      appendWorkSessionInput(workspaceId, work.id, "Rejected turn", {
        modelOverride: { providerId: alternate.id, model: "missing" },
      }),
    ).rejects.toMatchObject({ code: "modelOverrideUnavailable" });
    expect(
      await db.message.count({
        where: { conversationId: work.conversationId },
      }),
    ).toBe(1);
    expect(
      await db.workSession.findUniqueOrThrow({ where: { id: work.id } }),
    ).toMatchObject({ status: "idle" });
    expect(
      await appendWorkSessionInput(workspaceId, work.id, "Default second turn"),
    ).toMatchObject({ ok: true });
    const messages = await db.message.findMany({
      where: { conversationId: work.conversationId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(agentMessageModelOverride(messages.at(-1)?.parts)).toBeUndefined();
    expect(
      await db.workSession.findUniqueOrThrow({ where: { id: work.id } }),
    ).toMatchObject({
      agentRevisionId: revision.id,
      runtimeSnapshot: work.runtimeSnapshot,
    });
    expect(await db.agentRevision.count({ where: { agentId: agent.id } })).toBe(
      1,
    );
    expect(
      await db.agentRevision.findUniqueOrThrow({ where: { id: revision.id } }),
    ).toMatchObject({ config: revision.config });
  });
  it("rejects stale publication CAS without advancing the default or adding a revision", async () => {
    const { agent, config, revision } = await fixture();
    const next = await publishAgentRevision(workspaceId, agent.id, {
      expectedRevisionId: revision.id,
      config: { ...config, systemPrompt: "second" },
    });
    await expect(
      publishAgentRevision(workspaceId, agent.id, {
        expectedRevisionId: revision.id,
        config,
      }),
    ).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    expect(
      await db.agent.findUniqueOrThrow({ where: { id: agent.id } }),
    ).toMatchObject({ currentRevisionVersion: next.version });
    expect(await db.agentRevision.count({ where: { agentId: agent.id } })).toBe(
      2,
    );
  });

  it("keeps the previous published default when configuration validation fails", async () => {
    const { agent, config, revision } = await fixture();
    await expect(
      publishAgentRevision(workspaceId, agent.id, {
        expectedRevisionId: revision.id,
        config: { ...config, runtimeKind: "hermes" },
      }),
    ).rejects.toThrow();
    const current = await db.$transaction((tx) =>
      requireAgentRevision(tx, agent.id),
    );
    expect(current.id).toBe(revision.id);
    expect(current.config.systemPrompt).toBe("approved prompt");
    expect(await db.agentRevision.count({ where: { agentId: agent.id } })).toBe(
      1,
    );
  });

  it("rolls back by publishing a higher version and refuses revoked live grants", async () => {
    const { agent, config, revision } = await fixture();
    const changed = await publishAgentRevision(workspaceId, agent.id, {
      expectedRevisionId: revision.id,
      config: { ...config, systemPrompt: "new prompt" },
    });
    const restored = await rollbackAgentRevision(
      workspaceId,
      agent.id,
      revision.id,
      changed.id,
    );
    expect(restored.version).toBe(changed.version + 1);
    expect(restored.id).not.toBe(revision.id);
    expect(restored.config.systemPrompt).toBe("approved prompt");
    await db.agent.update({
      where: { id: agent.id },
      data: { providerId: null },
    });
    await expect(
      rollbackAgentRevision(workspaceId, agent.id, revision.id, restored.id),
    ).rejects.toMatchObject({ code: "AGENT_PROVIDER_REVOKED" });
    expect(
      await db.agent.findUniqueOrThrow({ where: { id: agent.id } }),
    ).toMatchObject({ currentRevisionVersion: restored.version });
    expect(await db.agentRevision.count({ where: { agentId: agent.id } })).toBe(
      3,
    );
  }, 20_000);

  it("rejects explicit unresolved and wrong-owner pins instead of selecting the current default", async () => {
    const first = await fixture();
    const second = await fixture();
    await expect(
      db.$transaction((tx) => requireAgentRevision(tx, first.agent.id, null)),
    ).rejects.toMatchObject({ code: "AGENT_REVISION_UNRESOLVED" });
    await expect(
      db.$transaction((tx) =>
        requireAgentRevision(tx, second.agent.id, first.revision.id),
      ),
    ).rejects.toMatchObject({ code: "AGENT_REVISION_UNRESOLVED" });
    const live = await getAgentForRun(second.agent.id, workspaceId);
    if (!live) throw new Error("Missing fixture Agent");
    await expect(
      resolvePinnedAgent(live, first.revision.id),
    ).rejects.toMatchObject({ code: "AGENT_REVISION_UNRESOLVED" });
    await expect(resolvePinnedAgent(live, null)).rejects.toMatchObject({
      code: "AGENT_REVISION_UNRESOLVED",
    });
  });

  it("pins Work and Conversation together and resolves original configuration after publication", async () => {
    const { agent, config, revision } = await fixture();
    const work = await createWorkSession({
      workspaceId,
      agentId: agent.id,
      task: "Pinned work",
    });
    expect(work).toMatchObject({
      agentRevisionId: revision.id,
      legacyRevisionUnresolved: false,
      conversation: {
        agentRevisionId: revision.id,
        legacyRevisionUnresolved: false,
      },
    });
    await publishAgentRevision(workspaceId, agent.id, {
      expectedRevisionId: revision.id,
      config: { ...config, systemPrompt: "new prompt" },
    });
    const live = await getAgentForRun(agent.id, workspaceId);
    if (!live || !work) throw new Error("Missing fixture");
    const pinned = await resolvePinnedAgent(live, work.agentRevisionId);
    expect(pinned.systemPrompt).toBe("approved prompt");
    const next = await createWorkSession({
      workspaceId,
      agentId: agent.id,
      task: "New work",
    });
    expect(next?.agentRevisionId).not.toBe(work.agentRevisionId);
  });
  it("keeps local grant revision stable while live inbound revocation denies execution", async () => {
    const { agent, config, revision } = await fixture();
    const grant = await createLocalRootGrant(workspaceId, agent.id, userId);
    expect(grant.agentRevisionId).toBe(revision.id);
    const first = await submitTask(
      grant,
      SendMessageRequest.fromJSON({
        message: {
          messageId: randomUUID(),
          role: "ROLE_USER",
          parts: [{ text: "First task" }],
        },
      }),
    );
    expect(
      await db.a2AContext.findUnique({ where: { id: first.contextId } }),
    ).toMatchObject({
      agentRevisionId: revision.id,
      legacyRevisionUnresolved: false,
    });
    await publishAgentRevision(workspaceId, agent.id, {
      expectedRevisionId: revision.id,
      config: { ...config, systemPrompt: "new default" },
    });
    await expect(assertLocalGrant(grant)).resolves.toBeUndefined();
    await requestCancellation(grant, first.id);
    const refreshedGrant = await createLocalRootGrant(
      workspaceId,
      agent.id,
      userId,
    );
    expect(refreshedGrant.agentRevisionId).not.toBe(revision.id);
    const continued = await submitTask(
      refreshedGrant,
      SendMessageRequest.fromJSON({
        message: {
          messageId: randomUUID(),
          contextId: first.contextId,
          role: "ROLE_USER",
          parts: [{ text: "Continue the original context" }],
        },
      }),
    );
    expect(continued.contextId).toBe(first.contextId);
    expect(continued.grant).toMatchObject({ agentRevisionId: revision.id });
    await db.agent.update({
      where: { id: agent.id },
      data: { a2aInboundEnabled: false },
    });
    await expect(assertLocalGrant(grant)).rejects.toThrow();
  });
  it("persists trusted native prompt metadata without replacing raw input or attributing another user message", async () => {
    const { agent } = await fixture();
    const grant = await createLocalRootGrant(workspaceId, agent.id, userId);
    const messageId = randomUUID();
    const accepted = await submitTask(
      grant,
      SendMessageRequest.fromJSON({
        message: {
          messageId,
          role: "ROLE_USER",
          parts: [{ text: "/review src" }],
        },
      }),
    );
    const active = await claimTask(accepted.id);
    if (!active?.leaseToken) throw new Error("SDK claim required");
    const invocation = {
      name: "review",
      source: {
        marketInstallId: "install",
        releaseId: "release",
        checksum: "a".repeat(64),
        path: "prompts/review.md",
      },
      version: "1.0.0",
      rawArguments: "src",
      arguments: ["src"],
      finalInput: "Review src",
    };
    await expect(
      recordLocalPromptInvocation(
        active.id,
        "stale-lease",
        messageId,
        invocation,
      ),
    ).rejects.toThrow();
    await recordLocalPromptInvocation(
      active.id,
      active.leaseToken,
      messageId,
      invocation,
    );
    const recorded = await db.a2ATask.findUniqueOrThrow({
      where: { id: active.id },
    });
    const task = Task.fromJSON(recorded.snapshot);
    expect(
      task.history.find((message) => message.messageId === messageId)?.parts[0]
        .content,
    ).toEqual({ $case: "text", value: "/review src" });
    expect(agentEntryPromptInvocations(task, messageId)).toEqual([invocation]);
    task.history.push(
      Message.fromJSON({
        messageId: "next-user",
        contextId: task.contextId,
        taskId: task.id,
        role: Role.ROLE_USER,
        parts: [],
      }),
    );
    expect(agentEntryPromptInvocations(task, "next-user")).toEqual([]);
    expect(agentEntryPromptInvocations(task, messageId)).toEqual([invocation]);
  });
  it("never assigns the current revision to unresolved historical Work", async () => {
    const { agent } = await fixture();
    const conversation = await db.conversation.create({
      data: { agentId: agent.id },
    });
    const work = await db.workSession.create({
      data: {
        workspaceId,
        agentId: agent.id,
        conversationId: conversation.id,
        task: "History",
        runtimeKind: "pi-sdk",
        runtimeSnapshot: {},
        status: "failed",
      },
    });
    await expect(
      resumeWorkSession(workspaceId, work.id),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_transition" });
    await expect(
      appendWorkSessionInput(workspaceId, work.id, "Continue"),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_transition" });
    expect(
      await db.workSession.findUnique({ where: { id: work.id } }),
    ).toMatchObject({ agentRevisionId: null, legacyRevisionUnresolved: true });
  });
  it("intersects directional scopes and every authorization reservation bound", () => {
    const pinned: AgentA2APolicy["targets"][number] = {
      kind: "local",
      targetId: "target",
      capabilityIds: ["approved"],
      maxCalls: 2,
      maxDepth: 2,
      maxConcurrent: 2,
      timeoutSeconds: 30,
      maxInputBytes: 100,
      dataAllowance: "text_only",
      budget: {
        currency: "USD",
        maxAuthorizedCostMicros: 100,
        authorizedCostPerCallMicros: 10,
      },
    };
    const result = intersectCollaborationPolicy(pinned, {
      ...pinned,
      capabilityIds: ["approved", "expanded"],
      maxCalls: 10,
      maxDepth: 1,
      maxConcurrent: 1,
      timeoutSeconds: 60,
      maxInputBytes: 50,
      budget: {
        currency: "USD",
        maxAuthorizedCostMicros: 200,
        authorizedCostPerCallMicros: 20,
      },
    });
    expect(result).toMatchObject({
      capabilityIds: ["approved"],
      maxCalls: 2,
      maxDepth: 1,
      maxConcurrent: 1,
      timeoutSeconds: 30,
      maxInputBytes: 50,
      budget: { maxAuthorizedCostMicros: 100, authorizedCostPerCallMicros: 20 },
    });
  });
});
