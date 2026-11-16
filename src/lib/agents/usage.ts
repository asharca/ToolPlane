import "server-only";
import type { Prisma, A2ATask, AgentUsage } from "@prisma/client";
import { Task, TaskState } from "@a2a-js/sdk";
import { UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { db } from "@/lib/db";
import {
  isLocalGrant,
  type TaskGrant,
  type LocalA2AGrant,
} from "@/lib/a2a/principal";
import { parseRuntimeUsage, type RuntimeUsage } from "./runtime-commands";
import { recordEvent } from "@/lib/observability/events";
import type { AgentRuntimeTokenPayload } from "./runtime-access";
import type { BudgetWarning } from "./budget-warning";

export function utcMonth(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
export async function assertAgentBudget(
  tx: Prisma.TransactionClient,
  agentId: string,
) {
  const agent = await tx.agent.findUniqueOrThrow({ where: { id: agentId } });
  if (agent.monthlyBudgetMicros === null) return;
  const sum = await tx.agentUsage.aggregate({
    where: { agentId, createdAt: { gte: utcMonth() } },
    _sum: { costMicros: true },
  });
  if ((sum._sum.costMicros ?? BigInt(0)) >= agent.monthlyBudgetMicros)
    throw new UnsupportedOperationError("AGENT_BUDGET_EXCEEDED");
}
export type TaskUsage = {
  usage: RuntimeUsage;
  model?: string;
  providerId?: string;
};
export class MeteredExecutionError extends Error {
  constructor(
    public readonly cause: unknown,
    public readonly metering: TaskUsage,
  ) {
    super(cause instanceof Error ? cause.message : "PI_EXECUTION_FAILED");
  }
}
// The sandbox model definition carries zero rates (pricing stays server-side), so Pi's own
// cost.total is always 0. Price tokens with the workspace model catalog (USD per 1M tokens).
export async function usageCostUsd(
  usage: RuntimeUsage,
  metering?: TaskUsage,
): Promise<number> {
  if (usage.costUsd) return usage.costUsd;
  if (usage.modelUsage?.length) {
    const costs = await Promise.all(
      usage.modelUsage.map((entry) =>
        usageCostUsd(entry, {
          usage: entry,
          providerId: entry.providerId,
          model: entry.model,
        }),
      ),
    );
    return costs.reduce((sum, cost) => sum + cost, 0);
  }
  if (!metering?.providerId || !metering.model) return 0;
  const model = await db.providerModel.findFirst({
    where: { providerId: metering.providerId, modelId: metering.model },
    select: { cost: true },
  });
  const rate = (model?.cost ?? {}) as Partial<
    Record<"input" | "output" | "cacheRead" | "cacheWrite", unknown>
  >;
  const price = (key: keyof typeof rate) =>
    typeof rate[key] === "number" && Number.isFinite(rate[key]) && rate[key] > 0
      ? rate[key]
      : 0;
  return (
    (usage.inputTokens * price("input") +
      usage.outputTokens * price("output") +
      usage.cacheReadTokens * price("cacheRead") +
      usage.cacheWriteTokens * price("cacheWrite")) /
    1_000_000
  );
}
/** Source attribution is independent of whether a model request was billed. */
export async function agentTaskConversationId(grant: LocalA2AGrant) {
  const entry = grant.entryPolicy;
  if (grant.ancestorTaskIds.length || !entry) return null;
  let conversationId: string | undefined =
    entry.conversationId ?? entry.sourceId;
  if (entry.kind === "work") {
    const work = await db.workSession.findFirst({
      where: {
        id: entry.sourceId,
        workspaceId: grant.workspaceId,
        agentId: grant.agentId,
        a2aActorId: grant.actorId,
      },
      select: { conversationId: true },
    });
    conversationId = work?.conversationId;
  }
  if (!conversationId) return null;
  const conversation = await db.conversation.findFirst({
    where: {
      id: conversationId,
      agentId: grant.agentId,
      agent: { workspaceId: grant.workspaceId },
    },
    select: { id: true },
  });
  return conversation?.id ?? null;
}

async function recordBudgetCrossing(
  tx: Prisma.TransactionClient,
  grant: LocalA2AGrant,
  taskId: string,
  addedCost: bigint,
): Promise<BudgetWarning | undefined> {
  const agent = await tx.agent.findUniqueOrThrow({
    where: { id: grant.agentId },
  });
  if (agent.monthlyBudgetMicros === null || addedCost <= BigInt(0)) return;
  const sum = await tx.agentUsage.aggregate({
    where: { agentId: grant.agentId, createdAt: { gte: utcMonth() } },
    _sum: { costMicros: true },
  });
  const spent = sum._sum.costMicros ?? BigInt(0);
  const before = spent - addedCost;
  if (before >= agent.monthlyBudgetMicros || spent < agent.monthlyBudgetMicros)
    return;
  const usage = await tx.agentUsage.findUniqueOrThrow({ where: { taskId } });
  if (usage.budgetWarning || usage.createdAt < utcMonth()) return;
  const warning: BudgetWarning = {
    taskId,
    agentId: grant.agentId,
    month: utcMonth().toISOString().slice(0, 7),
    spentMicros: spent.toString(),
    monthlyBudgetMicros: agent.monthlyBudgetMicros.toString(),
    currency: "USD",
    unit: "micros",
  };
  await tx.agentUsage.update({
    where: { taskId },
    data: { budgetWarning: warning },
  });
  return warning;
}

async function logBudgetWarning(grant: LocalA2AGrant, warning?: BudgetWarning) {
  if (!warning) return;
  await recordEvent({
    domain: "agent",
    eventName: "agent.budget.exceeded",
    level: "warn",
    outcome: "success",
    workspaceId: grant.workspaceId,
    agentId: grant.agentId,
    taskId: warning.taskId,
    errorCode: "AGENT_BUDGET_EXCEEDED",
  });
}

/** Called once per gateway response, never used to reject or cancel an active turn. */
export async function recordAgentModelUsage(
  token: Pick<
    AgentRuntimeTokenPayload,
    "workspaceId" | "agentId" | "a2aTaskId" | "a2aLeaseToken" | "providerId"
  >,
  metering: TaskUsage,
) {
  if (!token.a2aTaskId || !token.a2aLeaseToken) return;
  const row = await db.a2ATask.findFirst({
    where: {
      id: token.a2aTaskId,
      context: { workspaceId: token.workspaceId, agentId: token.agentId },
    },
  });
  if (!row || row.leaseToken !== token.a2aLeaseToken) return;
  const grant = row.grant as unknown as TaskGrant;
  if (
    !isLocalGrant(grant) ||
    grant.agentId !== token.agentId ||
    grant.workspaceId !== token.workspaceId
  )
    return;
  const conversationId = await agentTaskConversationId(grant);
  const costMicros = BigInt(
    Math.round((await usageCostUsd(metering.usage, metering)) * 1_000_000),
  );
  const warning = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${grant.workspaceId} FOR UPDATE`;
    const previous = await tx.agentUsage.findUnique({
      where: { taskId: row.id },
    });
    if (previous?.meteringCompleted) return;
    const values = {
      inputTokens: Math.round(metering.usage.inputTokens),
      outputTokens: Math.round(metering.usage.outputTokens),
      cacheReadTokens: Math.round(metering.usage.cacheReadTokens),
      cacheWriteTokens: Math.round(metering.usage.cacheWriteTokens),
      costMicros,
    };
    if (previous) {
      await tx.agentUsage.update({
        where: { taskId: row.id },
        data: {
          inputTokens: { increment: values.inputTokens },
          outputTokens: { increment: values.outputTokens },
          cacheReadTokens: { increment: values.cacheReadTokens },
          cacheWriteTokens: { increment: values.cacheWriteTokens },
          costMicros: { increment: costMicros },
        },
      });
    } else {
      await tx.agentUsage.create({
        data: {
          workspaceId: grant.workspaceId,
          agentId: grant.agentId,
          taskId: row.id,
          conversationId,
          entryKind: grant.entryPolicy?.kind ?? "delegation",
          model: metering.model,
          providerId: metering.providerId,
          ...values,
          succeeded: false,
          meteringCompleted: false,
        },
      });
    }
    return recordBudgetCrossing(tx, grant, row.id, costMicros);
  });
  await logBudgetWarning(grant, warning);
}

export async function recordAgentTaskUsage(row: A2ATask, metering?: TaskUsage) {
  const grant = row.grant as unknown as TaskGrant;
  if (!isLocalGrant(grant)) return;
  const current = await db.a2ATask.findUnique({ where: { id: row.id } });
  if (
    !current ||
    ![
      TaskState.TASK_STATE_COMPLETED,
      TaskState.TASK_STATE_FAILED,
      TaskState.TASK_STATE_REJECTED,
      TaskState.TASK_STATE_CANCELED,
      TaskState.TASK_STATE_INPUT_REQUIRED,
      TaskState.TASK_STATE_AUTH_REQUIRED,
    ].includes(current.state)
  )
    return;
  if (!metering) {
    for (const artifact of Task.fromJSON(current.snapshot).artifacts) {
      const metadata = artifact.metadata?.toolplanePiSdk as
        | { usage?: unknown; model?: { model?: string; providerId?: string } }
        | undefined;
      const usage = parseRuntimeUsage(metadata?.usage);
      if (usage) {
        metering = { usage, ...metadata?.model };
        break;
      }
    }
  }
  const succeeded = current.state === TaskState.TASK_STATE_COMPLETED;
  const conversationId = await agentTaskConversationId(grant);
  const costUsd = metering ? await usageCostUsd(metering.usage, metering) : 0;
  const warning = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${grant.workspaceId} FOR UPDATE`;
    const previous = await tx.agentUsage.findUnique({
      where: { taskId: row.id },
    });
    if (previous?.meteringCompleted) return;
    if (!metering && !succeeded && !previous) return;
    const usage = metering?.usage;
    // Terminal SDK totals are authoritative. Replace provisional observations with
    // exactly those totals (including downward corrections), never bill both.
    const values = usage
      ? {
          inputTokens: Math.round(usage.inputTokens),
          outputTokens: Math.round(usage.outputTokens),
          cacheReadTokens: Math.round(usage.cacheReadTokens),
          cacheWriteTokens: Math.round(usage.cacheWriteTokens),
          costMicros: BigInt(Math.round(costUsd * 1_000_000)),
        }
      : {
          inputTokens: previous?.inputTokens ?? 0,
          outputTokens: previous?.outputTokens ?? 0,
          cacheReadTokens: previous?.cacheReadTokens ?? 0,
          cacheWriteTokens: previous?.cacheWriteTokens ?? 0,
          costMicros: previous?.costMicros ?? BigInt(0),
        };
    await tx.agentUsage.upsert({
      where: { taskId: row.id },
      create: {
        workspaceId: grant.workspaceId,
        agentId: grant.agentId,
        taskId: row.id,
        conversationId,
        entryKind: grant.entryPolicy?.kind ?? "delegation",
        model: usage?.actualModel?.model ?? metering?.model,
        providerId: usage?.actualModel?.providerId ?? metering?.providerId,
        ...values,
        succeeded,
        meteringCompleted: true,
      },
      update: {
        ...values,
        succeeded,
        meteringCompleted: true,
        model: usage?.actualModel?.model ?? metering?.model,
        providerId: usage?.actualModel?.providerId ?? metering?.providerId,
      },
    });
    const crossed = await recordBudgetCrossing(
      tx,
      grant,
      row.id,
      values.costMicros - (previous?.costMicros ?? BigInt(0)),
    );
    const agent = await tx.agent.findUniqueOrThrow({
      where: { id: grant.agentId },
    });
    if (agent.monthlyBudgetMicros === null) return crossed;
    const month = utcMonth().toISOString().slice(0, 7);
    const sum = await tx.agentUsage.aggregate({
      where: { agentId: grant.agentId, createdAt: { gte: utcMonth() } },
      _sum: { costMicros: true },
    });
    if (
      (sum._sum.costMicros ?? BigInt(0)) * BigInt(5) <
        agent.monthlyBudgetMicros * BigInt(4) ||
      agent.budgetAlertedMonth === month
    )
      return crossed;
    await tx.agent.update({
      where: { id: agent.id },
      data: { budgetAlertedMonth: month },
    });
    const workspace = await tx.workspace.findUniqueOrThrow({
      where: { id: grant.workspaceId },
      include: { members: { where: { role: { in: ["owner", "admin"] } } } },
    });
    const recipients = [
      ...new Set([
        workspace.ownerId,
        ...workspace.members.map((m) => m.userId),
      ]),
    ];
    await tx.notification.create({
      data: {
        kind: "agent_budget_alert",
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        title: `${agent.name}: monthly budget alert`,
        body: `${agent.name} has used at least 80% of its monthly budget (${month}, UTC).`,
        recipients: { create: recipients.map((userId) => ({ userId })) },
      },
    });
    return crossed;
  });
  await logBudgetWarning(grant, warning);
}
export function usageTotals(rows: AgentUsage[]) {
  return rows.reduce(
    (a, r) => ({
      costUsd: a.costUsd + Number(r.costMicros) / 1_000_000,
      inputTokens: a.inputTokens + r.inputTokens,
      outputTokens: a.outputTokens + r.outputTokens,
      cacheReadTokens: a.cacheReadTokens + r.cacheReadTokens,
      cacheWriteTokens: a.cacheWriteTokens + r.cacheWriteTokens,
      turns: a.turns + Number(r.meteringCompleted),
      failedTurns: a.failedTurns + Number(r.meteringCompleted && !r.succeeded),
    }),
    {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 0,
      failedTurns: 0,
    },
  );
}
export function budgetDto(
  monthlyBudgetMicros: bigint | null,
  spentUsd: number,
) {
  const monthlyUsd =
    monthlyBudgetMicros === null
      ? null
      : Number(monthlyBudgetMicros) / 1_000_000;
  const percent =
    monthlyUsd === null
      ? null
      : monthlyUsd === 0
        ? 100
        : (spentUsd / monthlyUsd) * 100;
  return {
    monthlyUsd,
    spentUsd,
    percent,
    status:
      percent === null
        ? "none"
        : percent >= 100
          ? "exceeded"
          : percent >= 80
            ? "warning"
            : "ok",
  };
}
export function groupedUsage(
  rows: AgentUsage[],
  key: (r: AgentUsage) => string,
  field: "date" | "model",
) {
  const groups = new Map<string, AgentUsage[]>();
  for (const row of rows) {
    const k = key(row);
    const group = groups.get(k) ?? [];
    group.push(row);
    groups.set(k, group);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, values]) => ({ [field]: k, ...usageTotals(values) }));
}
