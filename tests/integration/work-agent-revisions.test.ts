// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SendMessageRequest, Task, Message, Role } from "@a2a-js/sdk";
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
import { nativeEntryPromptInvocations } from "@/lib/a2a/ingress";

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
  });

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
    expect(nativeEntryPromptInvocations(task, messageId)).toEqual([invocation]);
    task.history.push(
      Message.fromJSON({
        messageId: "next-user",
        contextId: task.contextId,
        taskId: task.id,
        role: Role.ROLE_USER,
        parts: [],
      }),
    );
    expect(nativeEntryPromptInvocations(task, "next-user")).toEqual([]);
    expect(nativeEntryPromptInvocations(task, messageId)).toEqual([invocation]);
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
