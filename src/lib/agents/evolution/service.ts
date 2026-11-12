import "server-only";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Task, TaskState } from "@a2a-js/sdk";
import type { AgentEvolutionRecord, Prisma, A2ATask } from "@prisma/client";
import type { z } from "zod";
import { db } from "@/lib/db";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import {
  captureInstalledSkillSnapshot,
  publishAgentRevisionInTransaction,
  requireAgentRevision,
  rollbackAgentRevision,
} from "@/lib/agents/revisions";
import { isLocalGrant, type TaskGrant } from "@/lib/a2a/principal";
import { marketReleaseChecksum } from "@/lib/pi-packages/artifact";
import {
  assertAgentBudget,
  utcMonth,
  usageCostUsd,
  agentTaskConversationId,
} from "@/lib/agents/usage";
import type { RuntimeUsage } from "@/lib/agents/runtime-commands";
import { EvolutionError } from "./errors";
import type { EvolutionScope } from "./contracts";
export type Scope = { agentId: string; workspaceId: string; actorId: string };
import { parseEvolutionPayload, privateSkillSchema } from "./schemas";
export type Payload = Record<string, unknown>;
export const payload = (row: AgentEvolutionRecord): Payload =>
  parseEvolutionPayload(row.kind, row.payload);
export function recordDto(row: AgentEvolutionRecord) {
  const data = payload(row);
  const safeData =
    row.kind === "reflection"
      ? {}
      : row.kind === "evaluation"
        ? {
            proposalId: data.proposalId,
            baselineRevisionId: data.baselineRevisionId,
            candidateRevisionId: data.candidateRevisionId,
            pareto: data.pareto,
            excludedCapabilities: data.excludedCapabilities,
          }
        : row.kind === "result"
          ? {
              caseId: data.caseId,
              variant: data.variant,
              output: data.output,
              quality: data.quality,
              judgeCostMicros: data.judgeCostMicros,
              inputTokens: data.inputTokens,
              outputTokens: data.outputTokens,
              executionImageId: data.executionImageId,
            }
          : data;
  return {
    ...safeData,
    id: row.id,
    status: row.status,
    version: row.version,
    costMicros:
      typeof data.costMicros === "string"
        ? data.costMicros
        : row.costMicros.toString(),
    failureCode: data.failureCode ?? row.failureCode,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}
export function createRecord(
  tx: Prisma.TransactionClient,
  scope: Scope,
  kind: string,
  data: Payload,
  status = "pending",
  key: string = randomUUID(),
) {
  const parsed = parseEvolutionPayload(kind, data);
  return tx.agentEvolutionRecord.create({
    data: {
      ...scope,
      kind,
      key,
      status,
      payload: parsed as Prisma.InputJsonValue,
    },
  });
}
export async function ownedRecord(
  scope: Scope,
  kind: string,
  id: string,
  tx: Prisma.TransactionClient = db,
) {
  const row = await tx.agentEvolutionRecord.findFirst({
    where: { id, agentId: scope.agentId, workspaceId: scope.workspaceId, kind },
  });
  if (!row) throw new EvolutionError("NOT_FOUND");
  return row;
}
export async function settings(scope: Scope) {
  return db.agentEvolutionSettings.upsert({
    where: { agentId: scope.agentId },
    create: { agentId: scope.agentId, actorId: scope.actorId },
    update: {},
  });
}
export async function settingsDto(scope: Scope) {
  const [row, sum] = await Promise.all([
    settings(scope),
    db.agentEvolutionRecord.aggregate({
      where: {
        agentId: scope.agentId,
        workspaceId: scope.workspaceId,
        kind: "charge",
        createdAt: { gte: utcMonth() },
      },
      _sum: { costMicros: true },
    }),
  ]);
  return {
    ...row,
    actorId: undefined,
    agentId: undefined,
    updatedAt: undefined,
    nextReflectionAt: row.nextReflectionAt?.toISOString() ?? null,
    monthlyBudgetMicros: row.monthlyBudgetMicros.toString(),
    spentMicros: (sum._sum.costMicros ?? BigInt(0)).toString(),
  };
}
export async function assertEvolutionBudget(scope: Scope) {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Agent" WHERE id=${scope.agentId} AND "workspaceId"=${scope.workspaceId} FOR UPDATE`;
    const config = await tx.agentEvolutionSettings.findUnique({
      where: { agentId: scope.agentId },
    });
    if (!config?.enabled) throw new EvolutionError("FORBIDDEN");
    const sum = await tx.agentEvolutionRecord.aggregate({
      where: {
        agentId: scope.agentId,
        kind: "charge",
        createdAt: { gte: utcMonth() },
      },
      _sum: { costMicros: true },
    });
    if ((sum._sum.costMicros ?? BigInt(0)) >= config.monthlyBudgetMicros)
      throw new EvolutionError("BUDGET_EXCEEDED");
    await assertAgentBudget(tx, scope.agentId);
  });
}
export async function charge(
  scope: Scope,
  jobId: string,
  usage: RuntimeUsage,
  providerId: string,
  model: string,
  requestId: string,
) {
  const costMicros = BigInt(
    Math.ceil(
      (await usageCostUsd(usage, { usage, providerId, model })) * 1_000_000,
    ),
  );
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Agent" WHERE id=${scope.agentId} FOR UPDATE`;
    const entry = await tx.agentEvolutionRecord.createMany({
      skipDuplicates: true,
      data: [
        {
          ...scope,
          kind: "charge",
          key: requestId,
          status: "succeeded",
          payload: { jobId, usage, providerId, model },
          costMicros,
        },
      ],
    });
    if (!entry.count) return;
    await tx.agentUsage.create({
      data: {
        agentId: scope.agentId,
        workspaceId: scope.workspaceId,
        taskId: `evolution:${requestId}`,
        entryKind: "evolution",
        model,
        providerId,
        inputTokens: Math.round(usage.inputTokens),
        outputTokens: Math.round(usage.outputTokens),
        cacheReadTokens: Math.round(usage.cacheReadTokens),
        cacheWriteTokens: Math.round(usage.cacheWriteTokens),
        costMicros,
        succeeded: true,
      },
    });
    await tx.agentEvolutionRecord.update({
      where: { id: jobId },
      data: { costMicros: { increment: costMicros } },
    });
  });
}
export async function validateScope(
  scope: Scope,
  value: EvolutionScope,
  tx: Prisma.TransactionClient = db,
) {
  if (value.kind === "conversation") {
    const found = await tx.conversation.findFirst({
      where: {
        id: value.conversationId,
        agentId: scope.agentId,
        agent: { workspaceId: scope.workspaceId },
      },
    });
    if (!found) throw new EvolutionError("NOT_FOUND");
  }
  if (value.kind === "task") {
    const row = await tx.a2ATask.findFirst({
      where: {
        id: value.taskId,
        context: { agentId: scope.agentId, workspaceId: scope.workspaceId },
      },
    });
    if (!row) throw new EvolutionError("NOT_FOUND");
  }
}
export async function mutatePlaybook(
  scope: Scope,
  input: {
    id: string;
    expectedVersion: number;
    status?: string;
    content?: string;
    mergeIds?: string[];
  },
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Agent" WHERE id=${scope.agentId} FOR UPDATE`;
    const row = await ownedRecord(scope, "playbook", input.id, tx);
    if (row.version !== input.expectedVersion)
      throw new EvolutionError("CONFLICT");
    const before = payload(row),
      content = input.content ?? String(before.content);
    const merged = [];
    for (const id of new Set(input.mergeIds ?? [])) {
      const other = await ownedRecord(scope, "playbook", id, tx);
      if (
        id === row.id ||
        !isDeepStrictEqual(payload(other).scope, before.scope)
      )
        throw new EvolutionError("INVALID_REQUEST");
      merged.push(String(payload(other).content));
      const archived = await tx.agentEvolutionRecord.update({
        where: { id },
        data: { status: "archived", version: { increment: 1 } },
      });
      await createRecord(
        tx,
        scope,
        "playbook-version",
        {
          ...payload(other),
          playbookId: id,
          version: archived.version,
          status: "archived",
        },
        "succeeded",
        `${id}:${archived.version}`,
      );
    }
    const status =
      input.content !== undefined || merged.length
        ? "pending"
        : (input.status ?? row.status);
    if (!["pending", "approved", "rejected", "archived"].includes(status))
      throw new EvolutionError("INVALID_REQUEST");
    const next = {
      ...before,
      content: [content, ...merged].join("\n\n"),
      reviewedById:
        status === "approved" || status === "rejected" ? scope.actorId : null,
    };
    const updated = await tx.agentEvolutionRecord.update({
      where: { id: row.id },
      data: {
        payload: next as Prisma.InputJsonValue,
        status,
        version: { increment: 1 },
      },
    });
    await createRecord(
      tx,
      scope,
      "playbook-version",
      { ...next, playbookId: row.id, version: updated.version, status },
      "succeeded",
      `${row.id}:${updated.version}`,
    );
    return updated;
  });
}
/** Called by the shared execution entry. Scope comes from the admitted grant and mapped session only. */
export async function turnPlaybook(
  scope: Scope,
  taskId: string,
  resumeCount: number,
  conversationId?: string,
  allowAgentScope = false,
) {
  return db.$transaction(async (tx) => {
    const key = `${taskId}:${resumeCount}`;
    const previous = await tx.agentEvolutionRecord.findUnique({
      where: {
        agentId_kind_key: { agentId: scope.agentId, kind: "turn", key },
      },
    });
    if (previous) {
      const text = String(payload(previous).text ?? "");
      return text
        ? `Reviewed scoped playbook (advisory; never expands tool or resource authority):\n${text}`
        : "";
    }
    const config = await tx.agentEvolutionSettings.findUnique({
      where: { agentId: scope.agentId },
    });
    const entries = config?.enabled
      ? await tx.agentEvolutionRecord.findMany({
          where: {
            agentId: scope.agentId,
            workspaceId: scope.workspaceId,
            kind: "playbook",
            status: "approved",
          },
          orderBy: { createdAt: "asc" },
        })
      : [];
    const selected = entries.filter((row) => {
      const value = payload(row).scope as EvolutionScope;
      return (
        (value.kind === "agent" && allowAgentScope) ||
        (value.kind === "task" && value.taskId === taskId) ||
        (value.kind === "conversation" &&
          value.conversationId === conversationId)
      );
    });
    const text = selected
      .map((row) => String(payload(row).content))
      .join("\n\n");
    await createRecord(
      tx,
      scope,
      "turn",
      {
        taskId,
        conversationId: conversationId ?? null,
        enabled: config?.enabled ?? false,
        agentScopeAllowed: allowAgentScope,
        entries: selected.map((row) => ({
          id: row.id,
          version: row.version,
          content: payload(row).content,
        })),
        text,
      },
      "succeeded",
      key,
    );
    return text
      ? `Reviewed scoped playbook (advisory; never expands tool or resource authority):\n${text}`
      : "";
  });
}
export async function recordEpisode(row: A2ATask) {
  const grant = row.grant as unknown as TaskGrant;
  if (!isLocalGrant(grant)) return;
  const current = await db.a2ATask.findUnique({
    where: { id: row.id },
    include: { context: true },
  });
  if (
    !current ||
    ![
      TaskState.TASK_STATE_COMPLETED,
      TaskState.TASK_STATE_FAILED,
      TaskState.TASK_STATE_REJECTED,
      TaskState.TASK_STATE_CANCELED,
    ].includes(current.state)
  )
    return;
  const usage = await db.agentUsage.findUnique({ where: { taskId: row.id } });
  const task = Task.fromJSON(current.snapshot);
  const summary = task.artifacts
    .flatMap((a) =>
      a.parts.flatMap((p) =>
        p.content?.$case === "text" ? [p.content.value] : [],
      ),
    )
    .join("\n")
    .slice(0, 20_000);
  const toolWhere = {
    agentId: grant.agentId,
    workspaceId: grant.workspaceId,
    kind: "tool-call",
    payload: { path: ["taskId"], equals: row.id },
  };
  const [toolCalls, toolFailures] = await Promise.all([
    db.agentEvolutionRecord.count({ where: toolWhere }),
    db.agentEvolutionRecord.count({
      where: { ...toolWhere, status: "failed" },
    }),
  ]);
  const episode = parseEvolutionPayload("episode", {
    taskId: row.id,
    conversationId:
      usage?.conversationId ?? (await agentTaskConversationId(grant)),
    revisionId: grant.agentRevisionId,
    outcome:
      current.state === TaskState.TASK_STATE_COMPLETED
        ? "succeeded"
        : current.state === TaskState.TASK_STATE_CANCELED
          ? "canceled"
          : "failed",
    summary,
    failureCode:
      current.state === TaskState.TASK_STATE_FAILED
        ? "PI_EXECUTION_FAILED"
        : null,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    costMicros: (usage?.costMicros ?? BigInt(0)).toString(),
    toolCalls,
    toolFailures,
  });
  await db.agentEvolutionRecord.createMany({
    skipDuplicates: true,
    data: [
      {
        agentId: grant.agentId,
        workspaceId: grant.workspaceId,
        actorId: grant.actorId,
        kind: "episode",
        key: row.id,
        status: "succeeded",
        payload: episode as Prisma.InputJsonValue,
      },
    ],
  });
}
export const newSkillSchema = privateSkillSchema;
export async function createProposal(
  scope: Scope,
  input: {
    kind: "prompt" | "skill";
    title: string;
    rationale: string;
    baseRevisionId: string;
    after?: unknown;
    newSkill?: z.infer<typeof newSkillSchema>;
    evidence?: { episodeIds: string[]; feedbackIds: string[] };
  },
  sourceKey?: string,
) {
  const before = await requireAgentRevision(
    db,
    scope.agentId,
    input.baseRevisionId,
  );
  const after = AgentRevisionConfigSchema.parse(input.after ?? before.config);
  if (after.runtimeKind !== "pi-sdk")
    throw new EvolutionError("INVALID_REQUEST");
  // Evolution may improve instructions, not grant new providers, tools or runtime resources.
  const allowed = {
    ...before.config,
    systemPrompt: after.systemPrompt,
    skills: after.skills,
  };
  if (!isDeepStrictEqual(after, allowed)) throw new EvolutionError("FORBIDDEN");
  if (
    input.kind === "prompt" &&
    (!isDeepStrictEqual(after.skills, before.config.skills) || input.newSkill)
  )
    throw new EvolutionError("INVALID_REQUEST");
  if (
    input.kind === "skill" &&
    !input.newSkill &&
    isDeepStrictEqual(after.skills, before.config.skills)
  )
    throw new EvolutionError("INVALID_REQUEST");
  if (
    input.kind === "skill" &&
    after.systemPrompt !== before.config.systemPrompt
  )
    throw new EvolutionError("INVALID_REQUEST");
  for (const skill of after.skills) {
    if (
      !before.config.skills.some(
        (s) => s.installedSkillId === skill.installedSkillId,
      )
    )
      throw new EvolutionError("FORBIDDEN");
    skill.checksum = marketReleaseChecksum({
      name: skill.name,
      slug: skill.slug,
      description: skill.description,
      markdown: skill.markdown,
      files: skill.files,
    });
  }
  const evidence = input.evidence ?? { episodeIds: [], feedbackIds: [] };
  for (const id of evidence.episodeIds) await ownedRecord(scope, "episode", id);
  for (const id of evidence.feedbackIds) {
    if (
      !(await db.agentMessageFeedback.findFirst({
        where: {
          id,
          message: {
            conversation: {
              agentId: scope.agentId,
              agent: { workspaceId: scope.workspaceId },
            },
          },
        },
      }))
    )
      throw new EvolutionError("NOT_FOUND");
  }
  return createRecord(
    db,
    scope,
    "proposal",
    {
      kind: input.kind,
      title: input.title,
      rationale: input.rationale,
      baseRevisionId: input.baseRevisionId,
      candidateRevisionId: null,
      reviewedById: null,
      before: before.config,
      after,
      newSkill: input.newSkill ?? null,
      evidence,
    },
    "pending",
    sourceKey,
  );
}
export async function reviewProposal(
  scope: Scope,
  id: string,
  decision: "approve" | "reject",
  expectedBaseRevisionId: string,
) {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Agent" WHERE id=${scope.agentId} FOR UPDATE`;
      const row = await ownedRecord(scope, "proposal", id, tx),
        p = payload(row);
      if (
        row.status !== "pending" ||
        p.baseRevisionId !== expectedBaseRevisionId
      )
        throw new EvolutionError("CONFLICT");
      const current = await requireAgentRevision(tx, scope.agentId);
      if (current.id !== expectedBaseRevisionId)
        throw new EvolutionError("CONFLICT");
      const after = AgentRevisionConfigSchema.parse(p.after);
      if (decision === "approve" && p.newSkill) {
        const skill = newSkillSchema.parse(p.newSkill);
        const created = await tx.installedSkill.create({
          data: {
            workspaceId: scope.workspaceId,
            source: "custom",
            name: skill.name,
            slug: `evolution-${randomUUID()}`,
            description: skill.description,
            content: skill.markdown,
            files: skill.files as Prisma.InputJsonValue,
            status: "published",
          },
        });
        await tx.agentSkill.create({
          data: { agentId: scope.agentId, installedSkillId: created.id },
        });
        after.skills.push(
          await captureInstalledSkillSnapshot(
            tx,
            scope.workspaceId,
            created.id,
          ),
        );
      }
      const candidate =
        decision === "approve"
          ? await publishAgentRevisionInTransaction(
              tx,
              scope.workspaceId,
              scope.agentId,
              {
                expectedRevisionId: current.id,
                config: after,
                purpose: "candidate",
              },
            )
          : null;
      return tx.agentEvolutionRecord.update({
        where: { id },
        data: {
          status: decision === "approve" ? "approved" : "rejected",
          version: { increment: 1 },
          payload: {
            ...p,
            after,
            candidateRevisionId: candidate?.id ?? null,
            reviewedById: scope.actorId,
          } as Prisma.InputJsonValue,
        },
      });
    },
    { timeout: 120_000 },
  );
}
export async function startRollout(
  scope: Scope,
  proposalId: string,
  evaluationId: string,
  percentage: number,
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Agent" WHERE id=${scope.agentId} FOR UPDATE`;
    const proposal = await ownedRecord(scope, "proposal", proposalId, tx),
      p = payload(proposal);
    const evaluation = await ownedRecord(scope, "evaluation", evaluationId, tx),
      e = payload(evaluation);
    const current = await requireAgentRevision(tx, scope.agentId);
    if (
      proposal.status !== "approved" ||
      evaluation.status !== "succeeded" ||
      e.proposalId !== proposalId ||
      e.baselineRevisionId !== current.id ||
      e.candidateRevisionId !== p.candidateRevisionId
    )
      throw new EvolutionError("CONFLICT");
    const results = await tx.agentEvolutionRecord.findMany({
      where: {
        agentId: scope.agentId,
        workspaceId: scope.workspaceId,
        kind: "result",
        payload: { path: ["evaluationId"], equals: evaluationId },
      },
    });
    if (
      !results.length ||
      results.some((result) => payload(result).failureCode !== null)
    )
      throw new EvolutionError("CONFLICT");
    if (
      await tx.agentEvolutionRecord.findFirst({
        where: { agentId: scope.agentId, kind: "rollout", status: "active" },
      })
    )
      throw new EvolutionError("CONFLICT");
    return createRecord(
      tx,
      scope,
      "rollout",
      {
        proposalId,
        evaluationId,
        percentage,
        baselineRevisionId: current.id,
        candidateRevisionId: p.candidateRevisionId,
      },
      "active",
    );
  });
}
export async function changeRollout(
  scope: Scope,
  id: string,
  action: "stop" | "promote" | "rollback",
  expectedDefaultRevisionId: string,
) {
  const row = await ownedRecord(scope, "rollout", id),
    p = payload(row);
  if (action === "rollback") {
    if (!["active", "promoted", "stopped"].includes(row.status))
      throw new EvolutionError("CONFLICT");
    const revision = await rollbackAgentRevision(
      scope.workspaceId,
      scope.agentId,
      String(p.baselineRevisionId),
      expectedDefaultRevisionId,
    );
    return db.agentEvolutionRecord.update({
      where: { id },
      data: {
        status: "rolled_back",
        payload: {
          ...p,
          rollbackRevisionId: revision.id,
        } as Prisma.InputJsonValue,
      },
    });
  }
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Agent" WHERE id=${scope.agentId} FOR UPDATE`;
      const live = await ownedRecord(scope, "rollout", id, tx);
      if (live.status !== "active") throw new EvolutionError("CONFLICT");
      const current = await requireAgentRevision(tx, scope.agentId);
      if (
        current.id !== expectedDefaultRevisionId ||
        current.id !== p.baselineRevisionId
      )
        throw new EvolutionError("CONFLICT");
      if (action === "promote") {
        const candidate = await requireAgentRevision(
          tx,
          scope.agentId,
          String(p.candidateRevisionId),
        );
        const revision = await publishAgentRevisionInTransaction(
          tx,
          scope.workspaceId,
          scope.agentId,
          {
            expectedRevisionId: current.id,
            config: candidate.config,
            purpose: "published",
          },
        );
        return tx.agentEvolutionRecord.update({
          where: { id },
          data: {
            status: "promoted",
            payload: {
              ...p,
              promotedRevisionId: revision.id,
            } as Prisma.InputJsonValue,
          },
        });
      }
      return tx.agentEvolutionRecord.update({
        where: { id },
        data: { status: "stopped" },
      });
    },
    { timeout: 120_000 },
  );
}

export async function rolloutDto(scope: Scope, row: AgentEvolutionRecord) {
  if (
    row.agentId !== scope.agentId ||
    row.workspaceId !== scope.workspaceId ||
    row.kind !== "rollout"
  )
    throw new EvolutionError("NOT_FOUND");
  const config = payload(row);
  const metrics = async (revisionId: string) => {
    const [totals] = await db.$queryRaw<
      Array<{
        tasks: number;
        succeeded: number;
        failed: number;
        toolCalls: bigint;
        toolFailures: bigint;
        averageCostMicros: string;
      }>
    >`
      SELECT COUNT(*)::integer AS tasks,
        COUNT(*) FILTER (WHERE payload->>'outcome'='succeeded')::integer AS succeeded,
        COUNT(*) FILTER (WHERE payload->>'outcome'<>'succeeded')::integer AS failed,
        COALESCE(SUM((payload->>'toolCalls')::bigint),0)::bigint AS "toolCalls",
        COALESCE(SUM((payload->>'toolFailures')::bigint),0)::bigint AS "toolFailures",
        COALESCE(ROUND(AVG((payload->>'costMicros')::numeric)),0)::text AS "averageCostMicros"
      FROM "AgentEvolutionRecord" WHERE "agentId"=${scope.agentId} AND "workspaceId"=${scope.workspaceId}
        AND kind='episode' AND payload->>'revisionId'=${revisionId} AND "createdAt">=${row.createdAt}`;
    const feedback = await db.agentMessageFeedback.groupBy({
      by: ["rating"],
      where: {
        createdAt: { gte: row.createdAt },
        message: {
          conversation: {
            agentId: scope.agentId,
            agentRevisionId: revisionId,
            agent: { workspaceId: scope.workspaceId },
          },
        },
      },
      _count: { _all: true },
    });
    return {
      ...totals,
      toolCalls: Number(totals.toolCalls),
      toolFailures: Number(totals.toolFailures),
      feedbackPositive:
        feedback.find((item) => item.rating === "positive")?._count._all ?? 0,
      feedbackNegative:
        feedback.find((item) => item.rating === "negative")?._count._all ?? 0,
      successRate: totals.tasks ? totals.succeeded / totals.tasks : null,
    };
  };
  const [baseline, candidate] = await Promise.all([
    metrics(String(config.baselineRevisionId)),
    metrics(String(config.candidateRevisionId)),
  ]);
  const ready = baseline.tasks >= 20 && candidate.tasks >= 20;
  const negativeRate = (value: typeof baseline) =>
    value.feedbackNegative /
    Math.max(1, value.feedbackNegative + value.feedbackPositive);
  const baselineSuccessRate = baseline.successRate;
  const candidateSuccessRate = candidate.successRate;
  const recommendation =
    !ready || baselineSuccessRate === null || candidateSuccessRate === null
      ? "collect_more"
      : candidateSuccessRate < baselineSuccessRate - 0.1 ||
          negativeRate(candidate) > negativeRate(baseline) + 0.2
        ? "rollback"
        : candidateSuccessRate >= baselineSuccessRate &&
            Number(candidate.averageCostMicros) <=
              Number(baseline.averageCostMicros) * 1.1
          ? "promote"
          : "review_tradeoff";
  return {
    ...recordDto(row),
    metrics: {
      baseline,
      candidate,
      sampleStatus: ready ? "ready" : "insufficient",
      recommendation,
    },
  };
}
