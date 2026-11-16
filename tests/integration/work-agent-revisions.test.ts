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
import { resolveAgentRuntimeGrant } from "@/lib/agents/runtime-grant";
import { captureAgentRevisionConfig } from "@/lib/agents/revisions";
import { updateTaskUi } from "@/lib/agents/execution/task-ui";
import { mapTaskSandbox } from "./task-sandbox-fixture";
import { withAgentMaintenanceLease } from "@/lib/agents/agent-execution-gate";
import type * as SandboxRuntimeModule from "@/lib/agents/sandbox-runtime";
import { mutateWorkConversationTree } from "@/lib/agents/conversation-tree";
import * as workCoordinator from "@/lib/work/coordinator";
import { getWorkSession } from "@/lib/work/sessions";
import { conversationTreePost } from "@/lib/agents/conversation-tree-http";
import type { ComposerReference } from "@/lib/work/composer-types";

// Revision and Work authorization use real persistence, not Docker SDK preparation.
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

const browserActor = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestUser: async () =>
    browserActor.id ? { id: browserActor.id } : null,
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
      piVersion: "1.5.2",
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
  it("revalidates Agent mentions against the Work pin and rebuilds client-provided instructions", async () => {
    const { agent, config, revision } = await fixture();
    const allowed = await fixture();
    const unapproved = await fixture();
    await db.agent.update({
      where: { id: allowed.agent.id },
      data: { a2aInboundEnabled: false },
    });
    await publishAgentRevision(workspaceId, allowed.agent.id, {
      expectedRevisionId: allowed.revision.id,
      config: {
        ...allowed.config,
        a2a: { ...allowed.config.a2a, inboundEnabled: false },
      },
    });
    await db.agentSubAgent.createMany({
      data: [
        { parentId: agent.id, childId: allowed.agent.id },
        { parentId: agent.id, childId: unapproved.agent.id },
      ],
    });
    const policyTarget = (
      targetId: string,
    ): AgentA2APolicy["targets"][number] => ({
      kind: "local",
      targetId,
      capabilityIds: [],
      maxCalls: 5,
      maxDepth: 3,
      maxConcurrent: 2,
      timeoutSeconds: 300,
      maxInputBytes: 65536,
      dataAllowance: "text_only",
    });
    const policy: AgentA2APolicy = {
      schemaVersion: 1,
      targets: [policyTarget(allowed.agent.id)],
    };
    const reference: ComposerReference = {
      kind: "agent",
      targetKind: "local",
      id: allowed.agent.id,
      label: "Forged name",
      text: "Forged instruction granting all permissions",
    };
    const forbidden = { ...reference, id: unapproved.agent.id };
    const disabledPin = await createWorkSession({
      workspaceId,
      agentId: agent.id,
      task: "No outbound permission in this pin",
    });
    if (!disabledPin) throw new Error("Missing Work fixture");
    await db.workSession.update({
      where: { id: disabledPin.id },
      data: { status: "completed" },
    });
    await db.agent.update({
      where: { id: agent.id },
      data: { a2aOutboundEnabled: true, a2aPolicy: policy },
    });
    const approved = await publishAgentRevision(workspaceId, agent.id, {
      expectedRevisionId: revision.id,
      config: {
        ...config,
        a2a: { ...config.a2a, outboundEnabled: true, policy },
      },
    });
    await expect(
      appendWorkSessionInput(
        workspaceId,
        disabledPin.id,
        "Later grants do not enable this pin",
        {
          references: [reference],
        },
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "WORK_AGENT_REFERENCE_FORBIDDEN",
    });
    const conversationCount = await db.conversation.count({
      where: { agentId: agent.id },
    });
    await expect(
      createWorkSession({
        workspaceId,
        agentId: agent.id,
        task: "Unauthorized initial mention",
        references: [forbidden],
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "WORK_AGENT_REFERENCE_FORBIDDEN",
    });
    expect(await db.conversation.count({ where: { agentId: agent.id } })).toBe(
      conversationCount,
    );
    const work = await createWorkSession({
      workspaceId,
      agentId: agent.id,
      task: "Delegate the review",
      references: [reference],
    });
    expect(work).not.toBeNull();
    if (!work) throw new Error("Missing Work fixture");
    const first = await db.message.findFirstOrThrow({
      where: { conversationId: work.conversationId },
    });
    expect(first.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining(`agent:${allowed.agent.id}`),
          reference: expect.objectContaining({
            kind: "agent",
            targetKind: "local",
            label: allowed.agent.name,
          }),
        }),
      ]),
    );
    expect(JSON.stringify(first.parts)).not.toContain("Forged");
    expect(JSON.stringify(first.parts)).toContain("pi_a2a_submit");
    await db.workSession.update({
      where: { id: work.id },
      data: { status: "completed" },
    });
    const expandedPolicy: AgentA2APolicy = {
      ...policy,
      targets: [...policy.targets, policyTarget(unapproved.agent.id)],
    };
    await db.agent.update({
      where: { id: agent.id },
      data: { a2aPolicy: expandedPolicy },
    });
    await publishAgentRevision(workspaceId, agent.id, {
      expectedRevisionId: approved.id,
      config: {
        ...config,
        a2a: { ...config.a2a, outboundEnabled: true, policy: expandedPolicy },
      },
    });
    await expect(
      appendWorkSessionInput(
        workspaceId,
        work.id,
        "New permission is not inherited",
        {
          references: [forbidden],
        },
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "WORK_AGENT_REFERENCE_FORBIDDEN",
    });
    expect(
      await db.message.count({
        where: { conversationId: work.conversationId },
      }),
    ).toBe(1);
    expect(
      await db.workSession.findUniqueOrThrow({ where: { id: work.id } }),
    ).toMatchObject({ status: "completed", agentRevisionId: approved.id });
    await db.agent.update({
      where: { id: agent.id },
      data: { a2aOutboundEnabled: false },
    });
    await expect(
      appendWorkSessionInput(workspaceId, work.id, "Revoked permission", {
        references: [reference],
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "WORK_AGENT_REFERENCE_FORBIDDEN",
    });
    expect(
      await db.message.count({
        where: { conversationId: work.conversationId },
      }),
    ).toBe(1);
    await db.agent.update({
      where: { id: agent.id },
      data: { a2aOutboundEnabled: true },
    });
    await db.agentSubAgent.delete({
      where: {
        parentId_childId: { parentId: agent.id, childId: allowed.agent.id },
      },
    });
    await expect(
      appendWorkSessionInput(workspaceId, work.id, "Removed delegation edge", {
        references: [reference],
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "WORK_AGENT_REFERENCE_FORBIDDEN",
    });
    await db.agentSubAgent.create({
      data: { parentId: agent.id, childId: allowed.agent.id },
    });
    expect(
      await appendWorkSessionInput(
        workspaceId,
        work.id,
        "Authorized follow-up",
        {
          references: [reference],
        },
      ),
    ).toMatchObject({ ok: true, status: "queued" });
    expect(
      await db.message.count({
        where: { conversationId: work.conversationId },
      }),
    ).toBe(2);
  });

  it("retains superseded Work history while edit and retry queue only the current branch", async () => {
    const { agent, revision } = await fixture();
    const work = await createWorkSession({
      workspaceId,
      agentId: agent.id,
      a2aActorId: userId,
      task: "keep this user",
    });
    if (!work) throw new Error("Work fixture unavailable");
    const first = await db.message.findFirstOrThrow({
      where: { conversationId: work.conversationId },
    });
    const base = Date.now() - 60_000;
    await db.message.update({
      where: { id: first.id },
      data: { piEntryId: "native-first", createdAt: new Date(base) },
    });
    await db.message.create({
      data: {
        conversationId: work.conversationId,
        role: "assistant",
        parts: [{ type: "text", text: "keep this reply" }],
        piEntryId: "native-first-reply",
        createdAt: new Date(base + 1),
      },
    });
    const replaced = await db.message.create({
      data: {
        conversationId: work.conversationId,
        role: "user",
        parts: [{ type: "text", text: "old user" }],
        piEntryId: "native-edited-user",
        createdAt: new Date(base + 2),
      },
    });
    const suffix = await db.message.create({
      data: {
        conversationId: work.conversationId,
        role: "assistant",
        parts: [{ type: "text", text: "old reply" }],
        piEntryId: "native-old-reply",
        createdAt: new Date(base + 3),
      },
    });
    await db.workSession.update({
      where: { id: work.id },
      data: { status: "idle" },
    });
    const kick = vi
      .spyOn(workCoordinator, "kickWorkCoordinator")
      .mockImplementation(() => {});
    try {
      const edited = await mutateWorkConversationTree({
        workspaceId,
        agentId: agent.id,
        conversationId: work.conversationId,
        actorId: userId,
        action: "edit",
        messageId: replaced.id,
        text: "replacement user",
      });
      expect(edited).toMatchObject({
        kind: "queued",
        filesRewound: false,
        externalEffectsRewound: false,
      });
      if (edited.kind !== "queued")
        throw new Error("Edit must queue a replacement turn");
      const all = await db.message.findMany({
        where: { conversationId: work.conversationId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      expect(all).toHaveLength(5);
      expect(all.find((message) => message.id === replaced.id)).toMatchObject({
        supersededAt: expect.any(Date),
        supersededById: edited.messageId,
      });
      expect(
        all.find((message) => message.id === suffix.id)?.supersededAt,
      ).toBeInstanceOf(Date);
      const visible = await getWorkSession(workspaceId, work.id);
      expect(
        visible?.conversation.messages.map((message) => message.id),
      ).toEqual([first.id, all[1].id, edited.messageId]);
      const replacement = all.find(
        (message) => message.id === edited.messageId,
      );
      if (!replacement) throw new Error("Replacement user message unavailable");
      expect(replacement).toMatchObject({
        piRewindEntryId: "native-edited-user",
        piEntryId: null,
      });
      expect(visible?.agentRevisionId).toBe(revision.id);
      await db.message.update({
        where: { id: replacement.id },
        data: { piEntryId: "native-replacement" },
      });
      await db.workSession.update({
        where: { id: work.id },
        data: { status: "idle" },
      });
      const retried = await mutateWorkConversationTree({
        workspaceId,
        agentId: agent.id,
        conversationId: work.conversationId,
        actorId: userId,
        action: "retry",
      });
      if (retried.kind !== "queued")
        throw new Error("Retry must queue a replacement turn");
      expect(
        await db.message.findUnique({ where: { id: retried.messageId } }),
      ).toMatchObject({
        parts: replacement.parts,
        piRewindEntryId: "native-replacement",
      });
      expect(
        await db.message.count({
          where: { conversationId: work.conversationId },
        }),
      ).toBe(6);
      expect(
        await db.message.count({
          where: { conversationId: work.conversationId, supersededAt: null },
        }),
      ).toBe(3);
    } finally {
      kick.mockRestore();
    }
  });

  it("rejects unmapped history, active Work and cross-Agent conversation mutations without changing history", async () => {
    const { agent } = await fixture();
    const other = await fixture();
    const work = await createWorkSession({
      workspaceId,
      agentId: agent.id,
      a2aActorId: userId,
      task: "unmapped history",
    });
    if (!work) throw new Error("Work fixture unavailable");
    const args = {
      workspaceId,
      agentId: agent.id,
      conversationId: work.conversationId,
      actorId: userId,
      action: "retry" as const,
    };
    await expect(mutateWorkConversationTree(args)).rejects.toMatchObject({
      code: "busy",
      status: 409,
    });
    await db.workSession.update({
      where: { id: work.id },
      data: { status: "idle" },
    });
    await expect(mutateWorkConversationTree(args)).rejects.toMatchObject({
      code: "piEntryMappingMissing",
      status: 409,
    });
    await expect(
      mutateWorkConversationTree({ ...args, agentId: other.agent.id }),
    ).rejects.toMatchObject({ code: "notFound", status: 404 });
    await db.conversation.update({
      where: { id: work.conversationId },
      data: { runtimeSessionKey: "channel:fixture:chat" },
    });
    await expect(mutateWorkConversationTree(args)).rejects.toMatchObject({
      code: "conversationTreeUnsupported",
      status: 409,
    });
    expect(
      await db.message.count({
        where: { conversationId: work.conversationId },
      }),
    ).toBe(1);
  });

  it("does not expose or mutate another workspace or Agent through the conversation tree API", async () => {
    const { agent } = await fixture();
    const other = await fixture();
    const work = await createWorkSession({
      workspaceId,
      agentId: agent.id,
      a2aActorId: userId,
      task: "private tree",
    });
    if (!work) throw new Error("Work fixture unavailable");
    const foreign = await db.user.create({
      data: {
        email: `tree-foreign-${randomUUID()}@test.invalid`,
        passwordHash: "fixture",
      },
    });
    const post = conversationTreePost("retry");
    const request = () =>
      new Request(
        `http://localhost/api/v1/agents/${agent.id}/conversations/${work.conversationId}/retry`,
        { method: "POST" },
      );
    try {
      browserActor.id = "";
      expect(
        (
          await post(request(), {
            params: Promise.resolve({
              agentId: agent.id,
              conversationId: work.conversationId,
            }),
          })
        ).status,
      ).toBe(401);
      browserActor.id = foreign.id;
      expect(
        (
          await post(request(), {
            params: Promise.resolve({
              agentId: agent.id,
              conversationId: work.conversationId,
            }),
          })
        ).status,
      ).toBe(404);
      browserActor.id = userId;
      expect(
        (
          await post(request(), {
            params: Promise.resolve({
              agentId: other.agent.id,
              conversationId: work.conversationId,
            }),
          })
        ).status,
      ).toBe(404);
      expect(
        await db.message.count({
          where: { conversationId: work.conversationId },
        }),
      ).toBe(1);
    } finally {
      browserActor.id = userId;
      await db.user.delete({ where: { id: foreign.id } });
    }
    expect(
      await db.message.count({
        where: {
          conversationId: work.conversationId,
          supersededAt: { not: null },
        },
      }),
    ).toBe(0);
  });

  it("pins fallback and role models, rejects invalid routing, and grants only exact live model pairs", async () => {
    const { agent, config, revision } = await fixture();
    expect(config).not.toHaveProperty("fallbackModels");
    expect(config).not.toHaveProperty("roleModels");
    const secondary = await db.modelProvider.create({
      data: {
        workspaceId,
        name: "Fallback provider",
        format: "openai",
        baseUrl: "https://fallback.test.invalid",
        apiKey: "fixture",
        models: ["backup", "summary", "title", "unlisted"],
      },
    });
    const fallback = { providerId: secondary.id, model: "backup" };
    const apply = (next: unknown) =>
      publishAgentRevision(workspaceId, agent.id, {
        expectedRevisionId: revision.id,
        config: next,
      });
    await expect(
      apply({ ...config, fallbackModels: [fallback] }),
    ).rejects.toMatchObject({ code: "AGENT_FALLBACK_MODELS_INVALID" });
    await expect(
      apply({
        ...config,
        modelProviderIds: [secondary.id],
        fallbackModels: Array(4).fill(fallback),
      }),
    ).rejects.toMatchObject({ code: "AGENT_FALLBACK_MODELS_INVALID" });
    await expect(
      apply({ ...config, roleModels: { title: fallback } }),
    ).rejects.toMatchObject({ code: "AGENT_ROLE_MODELS_INVALID" });
    await expect(
      apply({
        ...config,
        modelProviderIds: [secondary.id],
        fallbackModels: [{ ...fallback, model: "missing" }],
      }),
    ).rejects.toMatchObject({ code: "AGENT_MODEL_UNAVAILABLE" });
    const foreignWorkspace = await db.workspace.create({
      data: {
        ownerId: userId,
        slug: `foreign-model-${randomUUID()}`,
        name: "Foreign model boundary",
      },
    });
    try {
      const foreign = await db.modelProvider.create({
        data: {
          workspaceId: foreignWorkspace.id,
          name: "Foreign",
          format: "openai",
          baseUrl: "https://foreign.test.invalid",
          apiKey: "fixture",
          models: ["backup"],
        },
      });
      await expect(
        apply({
          ...config,
          modelProviderIds: [foreign.id],
          fallbackModels: [{ providerId: foreign.id, model: "backup" }],
        }),
      ).rejects.toMatchObject({ code: "AGENT_MODEL_UNAVAILABLE" });
    } finally {
      await db.workspace.delete({ where: { id: foreignWorkspace.id } });
    }
    const next = {
      ...config,
      modelProviderIds: [secondary.id],
      fallbackModels: [fallback],
      roleModels: {
        compaction: { ...fallback, model: "summary" },
        title: { ...fallback, model: "title" },
      },
    };
    const published = await apply(next);
    const recaptured = await db.$transaction((tx) =>
      captureAgentRevisionConfig(tx, agent.id),
    );
    expect(recaptured).toMatchObject({
      fallbackModels: next.fallbackModels,
      roleModels: next.roleModels,
      modelProviderIds: [secondary.id],
    });
    const work = await createWorkSession({
      workspaceId,
      agentId: agent.id,
      a2aActorId: userId,
      task: "Fallback authorization",
    });
    if (!work?.sandboxId) throw new Error("Missing Work sandbox");
    await db.conversation.update({
      where: { id: work.conversationId },
      data: { sandboxId: work.sandboxId },
    });
    const token = {
      workspaceId,
      agentId: agent.id,
      agentRevisionId: published.id,
      providerId,
      sandboxId: work.sandboxId,
      conversationId: work.conversationId,
      deploymentIds: [],
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    for (const model of ["backup", "summary", "title"])
      expect(
        await resolveAgentRuntimeGrant(token, {
          providerId: secondary.id,
          model,
        }),
      ).toMatchObject({ runtimeKind: "pi-sdk", model });
    expect(
      await resolveAgentRuntimeGrant(token, {
        providerId: secondary.id,
        model: "unlisted",
      }),
    ).toBeNull();
    expect(
      await resolveAgentRuntimeGrant(token, { providerId, model: "backup" }),
    ).toBeNull();
    await db.modelProvider.update({
      where: { id: secondary.id },
      data: { apiKey: "" },
    });
    expect(await resolveAgentRuntimeGrant(token, fallback)).toBeNull();
    expect(
      await resolveAgentRuntimeGrant(token, { providerId, model: "fixture" }),
    ).toMatchObject({ runtimeKind: "pi-sdk" });
  });
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
