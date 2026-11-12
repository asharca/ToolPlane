import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { isSameOriginRequest } from "@/lib/http/origin";
import { ORDINARY_AGENT_FILTER } from "./queries";
import { parseJson } from "./public-api/body";
import { AgentApiError } from "./public-api/errors";
import { takeAgentApiRateLimit } from "./public-api/rate-limit";
import {
  newTriggerSecret,
  nextTriggerRun,
  runAgentTrigger,
  triggerDto,
  verifyTriggerSecret,
} from "./triggers";
import { budgetDto, groupedUsage, usageTotals, utcMonth } from "./usage";
import { parseRuntimeFailure } from "./runtime-failure";
import { hostedRunnerSpec } from "./platform-runner";
import { liveAgentChannelStatus } from "./channel-runtime";
import { parseMessagingPromptSource } from "./messaging";

const deliveryConnectionSelect = {
  id: true,
  name: true,
  platform: true,
} as const;

const deliverySchema = z
  .object({
    connectionId: z.string().min(1).max(200),
    chatId: z.string().trim().min(1).max(256),
  })
  .strict()
  .nullable();

async function deliveryData(
  value: unknown,
  workspaceId: string,
  agentId: string,
) {
  if (value === undefined) return {};
  const parsed = deliverySchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data === null)
    return { deliveryConnectionId: null, deliveryChatId: null };
  const connection = await db.agentChannelConnection.findFirst({
    where: { id: parsed.data.connectionId, workspaceId, agentId },
    select: { platform: true },
  });
  if (!connection || !hostedRunnerSpec(connection.platform)) return null;
  return {
    deliveryConnectionId: parsed.data.connectionId,
    deliveryChatId: parsed.data.chatId,
  };
}

const createSchema = z
  .object({
    kind: z.enum(["schedule", "webhook"]),
    name: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(20_000),
    cron: z.string().max(200).optional(),
    timezone: z.string().max(100).optional(),
    enabled: z.boolean().optional(),
    delivery: z.unknown().optional(),
  })
  .strict();
const patchSchema = createSchema
  .omit({ kind: true })
  .partial()
  .extend({ rotateSecret: z.literal(true).optional() })
  .strict();
const budgetSchema = z
  .object({
    monthlyUsd: z.number().finite().min(0).max(1_000_000_000).nullable(),
  })
  .strict();
const jsonError = (error: string, status: number) =>
  Response.json({ error }, { status });
function apiFailure(error: unknown) {
  if (error instanceof AgentApiError)
    return jsonError(error.code, error.status);
  if (
    error instanceof Error &&
    parseRuntimeFailure(error.message)?.code === "AGENT_BUDGET_EXCEEDED"
  )
    return jsonError("AGENT_BUDGET_EXCEEDED", 402);
  return jsonError("TRIGGER_EXECUTION_FAILED", 409);
}
export async function handleAgentAutomation(
  req: Request,
  agentId: string,
  action: "triggers" | "trigger" | "run" | "usage" | "budget" | "targets",
  triggerId?: string,
) {
  const user = await resolveRequestUser(req);
  if (!user) return jsonError("Unauthorized", 401);
  const agent = await db.agent.findFirst({
    where: {
      id: agentId,
      ...ORDINARY_AGENT_FILTER,
      workspace: {
        status: "active",
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
    },
    include: {
      workspace: { include: { members: { where: { userId: user.id } } } },
    },
  });
  if (!agent) return jsonError("Not found", 404);
  if (req.method !== "GET") {
    if (
      (!req.headers.has("authorization") && !isSameOriginRequest(req)) ||
      (agent.workspace.ownerId !== user.id &&
        !agent.workspace.members.some((m) => m.role === "admin"))
    )
      return jsonError("Forbidden", 403);
  }
  if (action === "usage") {
    const range = usageRange(req);
    if (!range) return jsonError("INVALID_DAYS", 400);
    const rows = await db.agentUsage.findMany({
      where: { agentId, createdAt: { gte: range.queryStart } },
    });
    const monthToDate = usageTotals(
      rows.filter((r) => r.createdAt >= utcMonth()),
    );
    const recent = rows.filter((r) => r.createdAt >= range.start);
    return Response.json({
      monthToDate,
      budget: budgetDto(agent.monthlyBudgetMicros, monthToDate.costUsd),
      daily: groupedUsage(
        recent,
        (r) => r.createdAt.toISOString().slice(0, 10),
        "date",
      ),
      byModel: groupedUsage(recent, (r) => r.model ?? "unknown", "model"),
    });
  }
  if (action === "budget") {
    const body = await parseJson(req, budgetSchema, 1024);
    if (!body.ok) return jsonError("INVALID_BUDGET", 400);
    const monthlyBudgetMicros =
      body.value.monthlyUsd === null
        ? null
        : BigInt(Math.round(body.value.monthlyUsd * 1_000_000));
    await db.agent.update({
      where: { id: agentId },
      data: { monthlyBudgetMicros },
    });
    const rows = await db.agentUsage.findMany({
      where: { agentId, createdAt: { gte: utcMonth() } },
    });
    return Response.json({
      budget: budgetDto(monthlyBudgetMicros, usageTotals(rows).costUsd),
    });
  }
  if (action === "targets" && req.method === "GET") {
    const rows = await db.agentChannelConnection.findMany({
      where: { workspaceId: agent.workspaceId, agentId },
      select: { id: true, name: true, platform: true, status: true },
      orderBy: { createdAt: "asc" },
    });
    const connections = await Promise.all(
      rows
        .filter((row) => hostedRunnerSpec(row.platform))
        .map(async (row) => {
          const conversations = await db.conversation.findMany({
            where: {
              agentId,
              agent: { workspaceId: agent.workspaceId },
              runtimeSessionKey: { startsWith: `channel:${row.id}:` },
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 200,
            select: {
              messages: {
                where: { role: "user" },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                take: 1,
                select: { parts: true, createdAt: true },
              },
            },
          });
          const chats = new Map<
            string,
            {
              chatId: string;
              chatType: "dm" | "group" | "channel" | "thread";
              label: string;
              lastSeenAt: string;
            }
          >();
          const messages = conversations
            .flatMap((conversation) => conversation.messages)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          for (const message of messages) {
            if (!Array.isArray(message.parts)) continue;
            const text = message.parts
              .flatMap((part) =>
                part &&
                typeof part === "object" &&
                "type" in part &&
                part.type === "text" &&
                "text" in part &&
                typeof part.text === "string"
                  ? [part.text]
                  : [],
              )
              .join("\n");
            const source = parseMessagingPromptSource(text);
            if (!source?.chatId || chats.has(source.chatId)) continue;
            chats.set(source.chatId, {
              chatId: source.chatId,
              chatType: source.chatType,
              label:
                (source.chatType === "dm" ? source.userName : undefined) ||
                source.chatId,
              lastSeenAt: message.createdAt.toISOString(),
            });
            if (chats.size === 50) break;
          }
          return {
            ...row,
            status: ["running", "starting"].includes(row.status)
              ? liveAgentChannelStatus(row.id)
              : row.status,
            chats: [...chats.values()],
          };
        }),
    );
    return Response.json({ connections });
  }
  if (action === "triggers" && req.method === "GET") {
    const triggers = await db.agentTrigger.findMany({
      where: { agentId, workspaceId: agent.workspaceId },
      orderBy: { createdAt: "asc" },
      include: { deliveryConnection: { select: deliveryConnectionSelect } },
    });
    return Response.json({ triggers: triggers.map(triggerDto) });
  }
  const trigger = triggerId
    ? await db.agentTrigger.findFirst({
        where: { id: triggerId, agentId, workspaceId: agent.workspaceId },
        include: { deliveryConnection: { select: deliveryConnectionSelect } },
      })
    : null;
  if (triggerId && !trigger) return jsonError("Not found", 404);
  if (action === "run" && trigger) {
    try {
      return Response.json(await runAgentTrigger(trigger), { status: 202 });
    } catch (error) {
      return apiFailure(error);
    }
  }
  if (req.method === "DELETE" && trigger) {
    await db.agentTrigger.delete({ where: { id: trigger.id } });
    return new Response(null, { status: 204 });
  }
  if (req.method === "POST") {
    const body = await parseJson(req, createSchema, 64 * 1024);
    if (!body.ok)
      return jsonError(
        "INVALID_TRIGGER",
        body.reason === "too_large" ? 413 : 400,
      );
    const { delivery, ...value } = body.value;
    const target = await deliveryData(delivery, agent.workspaceId, agentId);
    if (!target) return jsonError("INVALID_TRIGGER_DELIVERY", 400);
    let nextRunAt: Date | null = null;
    try {
      if (value.kind === "schedule")
        nextRunAt = nextTriggerRun(value.cron ?? "", value.timezone ?? "UTC");
    } catch {
      return jsonError("INVALID_TRIGGER", 400);
    }
    const secret = value.kind === "webhook" ? newTriggerSecret() : null;
    const created = await db.agentTrigger.create({
      data: {
        ...value,
        ...target,
        cron: value.kind === "schedule" ? value.cron : null,
        timezone: value.kind === "schedule" ? (value.timezone ?? "UTC") : null,
        nextRunAt: value.enabled === false ? null : nextRunAt,
        workspaceId: agent.workspaceId,
        agentId,
        actorId: user.id,
        secretHash: secret?.secretHash,
      },
      include: { deliveryConnection: { select: deliveryConnectionSelect } },
    });
    return Response.json(
      {
        trigger: triggerDto(created),
        ...(secret ? { secret: secret.secret } : {}),
      },
      { status: 201 },
    );
  }
  if (req.method === "PATCH" && trigger) {
    const body = await parseJson(req, patchSchema, 64 * 1024);
    if (!body.ok)
      return jsonError(
        "INVALID_TRIGGER",
        body.reason === "too_large" ? 413 : 400,
      );
    const { rotateSecret, delivery, ...value } = body.value;
    const target = await deliveryData(delivery, agent.workspaceId, agentId);
    if (!target) return jsonError("INVALID_TRIGGER_DELIVERY", 400);
    if (trigger.kind !== "webhook" && rotateSecret)
      return jsonError("INVALID_TRIGGER", 400);
    if (
      trigger.kind === "webhook" &&
      (value.cron !== undefined || value.timezone !== undefined)
    )
      return jsonError("INVALID_TRIGGER", 400);
    let nextRunAt = trigger.nextRunAt;
    try {
      if (trigger.kind === "schedule") {
        const next = nextTriggerRun(
          value.cron ?? trigger.cron ?? "",
          value.timezone ?? trigger.timezone ?? "UTC",
        );
        nextRunAt = (value.enabled ?? trigger.enabled) ? next : null;
      }
    } catch {
      return jsonError("INVALID_TRIGGER", 400);
    }
    const secret = rotateSecret ? newTriggerSecret() : null;
    const updated = await db.agentTrigger.update({
      where: { id: trigger.id },
      data: {
        ...value,
        ...target,
        nextRunAt,
        ...(secret ? { secretHash: secret.secretHash } : {}),
      },
      include: { deliveryConnection: { select: deliveryConnectionSelect } },
    });
    return Response.json({
      trigger: triggerDto(updated),
      ...(secret ? { secret: secret.secret } : {}),
    });
  }
  return jsonError("Not found", 404);
}
function usageRange(req: Request) {
  const days = Number(new URL(req.url).searchParams.get("days") ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 366) return null;
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return {
    start,
    queryStart: new Date(Math.min(start.getTime(), utcMonth().getTime())),
  };
}
export async function handleWorkspaceAgentUsage(req: Request, slug: string) {
  const user = await resolveRequestUser(req);
  if (!user) return jsonError("Unauthorized", 401);
  const workspace = await db.workspace.findFirst({
    where: {
      slug,
      status: "active",
      OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
    },
  });
  if (!workspace) return jsonError("Not found", 404);
  const range = usageRange(req);
  if (!range) return jsonError("INVALID_DAYS", 400);
  const agents = await db.agent.findMany({
    where: { workspaceId: workspace.id, ...ORDINARY_AGENT_FILTER },
  });
  const rows = await db.agentUsage.findMany({
    where: {
      workspaceId: workspace.id,
      agentId: { in: agents.map((a) => a.id) },
      createdAt: { gte: range.queryStart },
    },
  });
  return Response.json({
    agents: agents.map((a) => {
      const usage = rows.filter((r) => r.agentId === a.id);
      return {
        agentId: a.id,
        name: a.name,
        ...usageTotals(usage.filter((r) => r.createdAt >= range.start)),
        budget: budgetDto(
          a.monthlyBudgetMicros,
          usageTotals(usage.filter((r) => r.createdAt >= utcMonth())).costUsd,
        ),
      };
    }),
    daily: groupedUsage(
      rows.filter((r) => r.createdAt >= range.start),
      (r) => r.createdAt.toISOString().slice(0, 10),
      "date",
    ),
  });
}
export async function handleTriggerWebhook(req: Request, triggerId: string) {
  const trigger = await db.agentTrigger.findUnique({
    where: { id: triggerId },
  });
  const bearer =
    /^Bearer ([^\s]+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ??
    "";
  if (
    trigger?.kind !== "webhook" ||
    !verifyTriggerSecret(trigger.secretHash, bearer)
  )
    return jsonError("Unauthorized", 401);
  if (!trigger.enabled) return jsonError("Not found", 404);
  try {
    await takeAgentApiRateLimit({
      endpointId: `trigger:${trigger.id}`,
      clientId: `trigger:${trigger.id}`,
      endpointRpm: 30,
      clientRpm: 30,
      endpointDaily: 1000,
      clientDaily: 1000,
    });
    const body = await parseJson(req, z.unknown(), 64 * 1024);
    if (!body.ok)
      return jsonError(
        "INVALID_TRIGGER",
        body.reason === "too_large" ? 413 : 400,
      );
    return Response.json(await runAgentTrigger(trigger, body.value), {
      status: 202,
    });
  } catch (error) {
    return apiFailure(error);
  }
}
