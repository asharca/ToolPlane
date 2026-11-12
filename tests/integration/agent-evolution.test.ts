// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import type { AgentRevisionConfig } from "@/lib/agents/revision-types";
import * as sandboxRuntime from "@/lib/agents/sandbox-runtime";
import * as piRuntime from "@/lib/agents/pi-runtime";
import { publishAgentRevisionInTransaction } from "@/lib/agents/revisions";
import { createConversation } from "@/lib/agents/mutations";
import { selectNewSessionRevision } from "@/lib/agents/evolution/rollout-selection";
import {
  handleEvolution,
  handleMessageFeedback,
} from "@/lib/agents/evolution/http";
import {
  assertEvolutionBudget,
  charge,
  createProposal,
  createRecord,
  mutatePlaybook,
  payload,
  reviewProposal,
  startRollout,
  changeRollout,
  turnPlaybook,
  validateScope,
  type Scope,
} from "@/lib/agents/evolution/service";
import { enqueueEvaluation } from "@/lib/agents/evolution/jobs";
const auth = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestUser: async () => (auth.id ? { id: auth.id } : null),
}));
const config: AgentRevisionConfig = {
  schemaVersion: 1,
  runtimeKind: "pi-sdk",
  systemPrompt: "Baseline",
  providerId: null,
  model: null,
  modelProviderIds: [],
  maxSteps: 10,
  disabledBuiltinTools: [],
  sandboxTemplateId: null,
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
    inboundEnabled: false,
    outboundEnabled: false,
    policy: { schemaVersion: 1, targets: [] },
  },
};
let scope: Scope,
  memberId: string,
  outsiderId: string,
  otherAgentId: string,
  baseId: string,
  conversationId: string,
  messageId: string;
const stamp = randomUUID();
const request = (method: string, body?: unknown) =>
  new Request("http://localhost/api", {
    method,
    headers: {
      authorization: "Bearer fixture",
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
beforeAll(async () => {
  const owner = await db.user.create({
    data: {
      email: `evolution-owner-${stamp}@example.invalid`,
      passwordHash: "fixture",
    },
  });
  const member = await db.user.create({
    data: {
      email: `evolution-member-${stamp}@example.invalid`,
      passwordHash: "fixture",
    },
  });
  memberId = member.id;
  const outsider = await db.user.create({
    data: {
      email: `evolution-outsider-${stamp}@example.invalid`,
      passwordHash: "fixture",
    },
  });
  outsiderId = outsider.id;
  const workspace = await db.workspace.create({
    data: {
      name: "Evolution test",
      slug: `evolution-${stamp}`,
      ownerId: owner.id,
      members: { create: { userId: member.id, role: "member" } },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      name: "Evolution",
      slug: "evolution",
      runtimeKind: "pi-sdk",
    },
  });
  otherAgentId = (
    await db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: "Other",
        slug: "other",
        runtimeKind: "pi-sdk",
      },
    })
  ).id;
  scope = { agentId: agent.id, workspaceId: workspace.id, actorId: owner.id };
  baseId = (
    await db.agentRevision.create({
      data: { agentId: agent.id, version: 1, config },
    })
  ).id;
  await db.agent.update({
    where: { id: agent.id },
    data: { currentRevisionVersion: 1 },
  });
  await db.agentEvolutionSettings.create({
    data: {
      agentId: agent.id,
      actorId: owner.id,
      enabled: true,
      monthlyBudgetMicros: BigInt(10_000_000),
    },
  });
  const conversation = await createConversation(workspace.id, agent.id);
  if (!conversation) throw new Error("Fixture conversation was not created");
  conversationId = conversation.id;
  messageId = (
    await db.message.create({
      data: {
        conversationId,
        role: "assistant",
        parts: [{ type: "text", text: "Actual result" }],
      },
    })
  ).id;
  auth.id = owner.id;
  // Only the external native preflight boundary is stubbed; DB lifecycle/authorization is real.
  vi.spyOn(sandboxRuntime, "preflightPiSdkCapabilities").mockResolvedValue({
    commands: [],
    tools: [],
    skills: [],
    prompts: [],
  });
  vi.spyOn(piRuntime, "preparePiRuntime").mockResolvedValue({
    path: "/fixture/pi-sdk.archive",
    sha256: "a".repeat(64),
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  if (scope) await db.workspace.delete({ where: { id: scope.workspaceId } });
  await db.user.deleteMany({
    where: {
      id: { in: [scope?.actorId, memberId, outsiderId].filter(Boolean) },
    },
  });
  await db.$disconnect();
});
it("persists feedback without crossing workspace, agent, role or private-source boundaries", async () => {
  auth.id = null;
  expect(
    (
      await handleMessageFeedback(
        request("GET"),
        scope.agentId,
        conversationId,
        messageId,
      )
    ).status,
  ).toBe(401);
  auth.id = outsiderId;
  expect(
    (
      await handleMessageFeedback(
        request("GET"),
        scope.agentId,
        conversationId,
        messageId,
      )
    ).status,
  ).toBe(404);
  auth.id = memberId;
  expect(
    (
      await handleMessageFeedback(
        request("PUT", {
          rating: "negative",
          comment: "Cannot read private conversation",
        }),
        scope.agentId,
        conversationId,
        messageId,
      )
    ).status,
  ).toBe(404);
  expect(
    (await handleEvolution(request("GET"), scope.agentId, "episodes")).status,
  ).toBe(403);
  auth.id = scope.actorId;
  const saved = await handleMessageFeedback(
    request("PUT", { rating: "positive", comment: "Useful" }),
    scope.agentId,
    conversationId,
    messageId,
  );
  expect(saved.status).toBe(200);
  expect((await saved.json()).data.createdById).toBe(scope.actorId);
  expect(
    (
      await handleMessageFeedback(
        request("GET"),
        otherAgentId,
        conversationId,
        messageId,
      )
    ).status,
  ).toBe(404);
  const userMessage = await db.message.create({
    data: { conversationId, role: "user", parts: [] },
  });
  expect(
    (
      await handleMessageFeedback(
        request("PUT", { rating: "positive" }),
        scope.agentId,
        conversationId,
        userMessage.id,
      )
    ).status,
  ).toBe(404);
  const read = await handleMessageFeedback(
    request("GET"),
    scope.agentId,
    conversationId,
    messageId,
  );
  expect((await read.json()).data.comment).toBe("Useful");
  await handleMessageFeedback(
    request("PUT", { rating: null }),
    scope.agentId,
    conversationId,
    messageId,
  );
  expect(await db.agentMessageFeedback.count({ where: { messageId } })).toBe(0);
});
it("only injects reviewed source-scoped memory and retains the actual turn snapshot", async () => {
  const memory = await createRecord(db, scope, "playbook", {
    scope: { kind: "conversation", conversationId },
    content: "Reviewed lesson",
    reviewedById: null,
  });
  expect(
    await turnPlaybook(scope, "turn-pending", 0, conversationId, true),
  ).toBe("");
  await mutatePlaybook(scope, {
    id: memory.id,
    expectedVersion: 1,
    status: "approved",
  });
  const first = await turnPlaybook(
    scope,
    "turn-pinned",
    0,
    conversationId,
    true,
  );
  expect(first).toContain("Reviewed lesson");
  await mutatePlaybook(scope, {
    id: memory.id,
    expectedVersion: 2,
    content: "Needs new review",
  });
  expect(
    await turnPlaybook(scope, "turn-pinned", 0, conversationId, true),
  ).toBe(first);
  expect(await turnPlaybook(scope, "turn-new", 0, conversationId, true)).toBe(
    "",
  );
  await expect(
    mutatePlaybook(scope, {
      id: memory.id,
      expectedVersion: 2,
      status: "approved",
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const global = await createRecord(db, scope, "playbook", {
    scope: { kind: "agent" },
    content: "Internal-only memory",
    reviewedById: null,
  });
  await mutatePlaybook(scope, {
    id: global.id,
    expectedVersion: 1,
    status: "approved",
  });
  expect(await turnPlaybook(scope, "external-turn", 0, undefined, false)).toBe(
    "",
  );
  expect(
    await turnPlaybook(scope, "internal-turn", 0, undefined, true),
  ).toContain("Internal-only memory");
  const foreign = await db.conversation.create({
    data: { agentId: otherAgentId },
  });
  await expect(
    validateScope(scope, { kind: "conversation", conversationId: foreign.id }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
it("allocates immutable candidates without changing the published default and skips identical ordinary publication", async () => {
  const candidate = await db.$transaction(
    (tx) =>
      publishAgentRevisionInTransaction(tx, scope.workspaceId, scope.agentId, {
        expectedRevisionId: baseId,
        config: { ...config, systemPrompt: "Candidate" },
        purpose: "candidate",
      }),
    { timeout: 120_000 },
  );
  expect(
    (await db.agent.findUniqueOrThrow({ where: { id: scope.agentId } }))
      .currentRevisionVersion,
  ).toBe(1);
  const next = await db.$transaction(
    (tx) =>
      publishAgentRevisionInTransaction(tx, scope.workspaceId, scope.agentId, {
        expectedRevisionId: baseId,
        config: { ...config, systemPrompt: "Candidate two" },
        purpose: "candidate",
      }),
    { timeout: 120_000 },
  );
  expect(next.version).toBe(candidate.version + 1);
  const unchanged = await db.$transaction(
    (tx) =>
      publishAgentRevisionInTransaction(tx, scope.workspaceId, scope.agentId, {
        expectedRevisionId: baseId,
        config,
      }),
    { timeout: 120_000 },
  );
  expect(unchanged.id).toBe(baseId);
  await expect(
    db.agentRevision.update({ where: { id: candidate.id }, data: { config } }),
  ).rejects.toThrow();
  await expect(
    db.$transaction((tx) =>
      publishAgentRevisionInTransaction(tx, scope.workspaceId, scope.agentId, {
        expectedRevisionId: candidate.id,
        config,
      }),
    ),
  ).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
});
it("creates and authorizes new private skills only on explicit CAS review", async () => {
  const proposal = await createProposal(scope, {
    kind: "skill",
    title: "Safer procedure",
    rationale: "Evidence-based procedure",
    baseRevisionId: baseId,
    newSkill: {
      name: "Safe procedure",
      description: "A scoped procedure",
      markdown:
        "---\nname: safe-procedure\ndescription: A scoped procedure\n---\nUse the reviewed procedure.",
      files: [],
    },
  });
  expect(await db.agentSkill.count({ where: { agentId: scope.agentId } })).toBe(
    0,
  );
  const approved = await reviewProposal(scope, proposal.id, "approve", baseId);
  expect(approved.status).toBe("approved");
  const after = payload(approved).after as AgentRevisionConfig;
  expect(after.skills).toHaveLength(1);
  expect(
    await db.installedSkill.findFirst({
      where: {
        id: after.skills[0].installedSkillId,
        workspaceId: scope.workspaceId,
        source: "custom",
      },
    }),
  ).not.toBeNull();
  expect(
    (await db.agent.findUniqueOrThrow({ where: { id: scope.agentId } }))
      .currentRevisionVersion,
  ).toBe(1);
  await expect(
    reviewProposal(scope, proposal.id, "approve", baseId),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});
it("freezes evaluation cases and canary sessions, then reauthorizes promotion and rollback as new revisions", async () => {
  const proposal = await createProposal(scope, {
    kind: "prompt",
    title: "Better instructions",
    rationale: "Task evidence",
    baseRevisionId: baseId,
    after: { ...config, systemPrompt: "Better instructions" },
  });
  const approved = await reviewProposal(scope, proposal.id, "approve", baseId),
    candidateId = String(payload(approved).candidateRevisionId);
  const test = await createRecord(
    db,
    scope,
    "case",
    {
      name: "Exact task",
      input: "Return 42",
      expected: "42",
      criterion: "exact",
      recordedTools: [],
      requiredTools: [],
    },
    "active",
  );
  const evaluation = await enqueueEvaluation(scope, proposal.id, [test.id]);
  await db.agentEvolutionRecord.update({
    where: { id: test.id },
    data: {
      payload: {
        name: "Edited",
        input: "Different",
        expected: "43",
        criterion: "exact",
        recordedTools: [],
        requiredTools: [],
      },
    },
  });
  expect((payload(evaluation).cases as Array<{ input: string }>)[0].input).toBe(
    "Return 42",
  );
  for (const variant of ["baseline", "candidate"])
    await createRecord(
      db,
      scope,
      "result",
      {
        evaluationId: evaluation.id,
        caseId: test.id,
        variant,
        output: "42",
        quality: 1,
        costMicros: "1",
        judgeCostMicros: "0",
        inputTokens: 1,
        outputTokens: 1,
        failureCode: null,
        criterion: "exact",
        caseSnapshot: (payload(evaluation).cases as object[])[0],
      },
      "succeeded",
    );
  await db.agentEvolutionRecord.update({
    where: { id: evaluation.id },
    data: { status: "succeeded", completedAt: new Date() },
  });
  const rollout = await startRollout(scope, proposal.id, evaluation.id, 100);
  expect((await selectNewSessionRevision(db, scope.agentId)).id).toBe(
    candidateId,
  );
  const fresh = await createConversation(scope.workspaceId, scope.agentId);
  if (!fresh) throw new Error("Canary conversation was not created");
  expect(fresh.agentRevisionId).toBe(candidateId);
  expect(
    (await db.conversation.findUniqueOrThrow({ where: { id: conversationId } }))
      .agentRevisionId,
  ).toBe(baseId);
  const promoted = await changeRollout(scope, rollout.id, "promote", baseId),
    promotedId = String(payload(promoted).promotedRevisionId);
  expect(promotedId).not.toBe(candidateId);
  const rollback = await changeRollout(
    scope,
    rollout.id,
    "rollback",
    promotedId,
  );
  expect(rollback.status).toBe("rolled_back");
  const restored = await db.agentRevision.findUniqueOrThrow({
    where: { id: String(payload(rollback).rollbackRevisionId) },
  });
  expect(restored.purpose).toBe("rollback");
  expect((restored.config as AgentRevisionConfig).systemPrompt).toBe(
    "Baseline",
  );
  expect(
    (await db.conversation.findUniqueOrThrow({ where: { id: fresh.id } }))
      .agentRevisionId,
  ).toBe(candidateId);
});
it("bills actual reflection model usage to both ledgers and enforces evolution and Agent budgets", async () => {
  const reflection = await createRecord(
    db,
    scope,
    "reflection",
    { baseRevisionId: baseId },
    "running",
  );
  const usage = {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.5,
  };
  await charge(
    scope,
    reflection.id,
    usage,
    "fixture-provider",
    "fixture-model",
    `billing-${stamp}`,
  );
  await charge(
    scope,
    reflection.id,
    usage,
    "fixture-provider",
    "fixture-model",
    `billing-${stamp}`,
  );
  expect(
    (
      await db.agentEvolutionRecord.findUniqueOrThrow({
        where: { id: reflection.id },
      })
    ).costMicros,
  ).toBe(BigInt(500000));
  expect(
    (
      await db.agentUsage.findUniqueOrThrow({
        where: { taskId: `evolution:billing-${stamp}` },
      })
    ).costMicros,
  ).toBe(BigInt(500000));
  await db.agentEvolutionSettings.update({
    where: { agentId: scope.agentId },
    data: { monthlyBudgetMicros: BigInt(500000) },
  });
  await expect(assertEvolutionBudget(scope)).rejects.toMatchObject({
    code: "BUDGET_EXCEEDED",
  });
  await db.agentEvolutionSettings.update({
    where: { agentId: scope.agentId },
    data: { monthlyBudgetMicros: BigInt(10_000_000) },
  });
  await db.agent.update({
    where: { id: scope.agentId },
    data: { monthlyBudgetMicros: BigInt(500000) },
  });
  await expect(assertEvolutionBudget(scope)).rejects.toThrow(
    "AGENT_BUDGET_EXCEEDED",
  );
});
