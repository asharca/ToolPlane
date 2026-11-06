import "server-only";
import type { Prisma, A2ATask, AgentUsage } from "@prisma/client";
import { Task, TaskState } from "@a2a-js/sdk";
import { UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { db } from "@/lib/db";
import { isLocalGrant, type TaskGrant } from "@/lib/a2a/principal";
import { parseRuntimeUsage, type RuntimeUsage } from "./runtime-commands";

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
async function usageCostUsd(usage: RuntimeUsage, metering?: TaskUsage) {
  if (usage.costUsd) return usage.costUsd;
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
  // A successful zero-token task still has an accounting row. Failed preparation has no model usage.
  if (!metering && current.state !== TaskState.TASK_STATE_COMPLETED) return;
  const usage = metering?.usage ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const entry = grant.entryPolicy;
  let conversationId =
    entry?.conversationId ??
    (entry && entry.kind !== "work" && entry.kind !== "trigger"
      ? entry.sourceId
      : undefined);
  if (entry?.kind === "work")
    conversationId = (
      await db.workSession.findUnique({
        where: { id: entry.sourceId },
        select: { conversationId: true },
      })
    )?.conversationId;
  const costUsd = await usageCostUsd(usage, metering);
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${grant.workspaceId} FOR UPDATE`;
    const created = await tx.agentUsage.createMany({
      skipDuplicates: true,
      data: [
        {
          workspaceId: grant.workspaceId,
          agentId: grant.agentId,
          taskId: row.id,
          conversationId,
          entryKind: entry?.kind ?? "delegation",
          model: metering?.model,
          providerId: metering?.providerId,
          inputTokens: Math.round(usage.inputTokens),
          outputTokens: Math.round(usage.outputTokens),
          cacheReadTokens: Math.round(usage.cacheReadTokens),
          cacheWriteTokens: Math.round(usage.cacheWriteTokens),
          costMicros: BigInt(Math.round(costUsd * 1_000_000)),
          succeeded: current.state === TaskState.TASK_STATE_COMPLETED,
        },
      ],
    });
    if (!created.count) return;
    const agent = await tx.agent.findUniqueOrThrow({
      where: { id: grant.agentId },
    });
    if (agent.monthlyBudgetMicros === null) return;
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
      return;
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
  });
}
export function usageTotals(rows: AgentUsage[]) {
  return rows.reduce(
    (a, r) => ({
      costUsd: a.costUsd + Number(r.costMicros) / 1_000_000,
      inputTokens: a.inputTokens + r.inputTokens,
      outputTokens: a.outputTokens + r.outputTokens,
      cacheReadTokens: a.cacheReadTokens + r.cacheReadTokens,
      cacheWriteTokens: a.cacheWriteTokens + r.cacheWriteTokens,
      turns: a.turns + 1,
      failedTurns: a.failedTurns + Number(!r.succeeded),
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
