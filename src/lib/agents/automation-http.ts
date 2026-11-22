import "server-only";
import {
  resolveWorkspaceScope,
  workspaceAccessWhere,
  workspaceScopeWhere,
} from "@/lib/workspace/scope";
import { z } from "zod";
import { db } from "@/lib/db";
import { configSchema, permitsHost } from "@/lib/account-connections/config";
import {
  isSourceKind,
  parseSourceConfig,
  sourceKinds,
  SourceFailure,
} from "./trigger-sources";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { ORDINARY_AGENT_FILTER } from "./queries";
import {
  parseJson,
  readRequestText,
  requestBodyMayFit,
} from "./public-api/body";
import { AgentApiError } from "./public-api/errors";
import { takeAgentApiRateLimit } from "./public-api/rate-limit";
import {
  acceptTriggerEvent,
  newTriggerSecret,
  nextTriggerRun,
  runAgentTrigger,
  triggerDto,
  triggerPrompt,
  verifyTriggerSecret,
} from "./triggers";
import {
  githubPromptPayload,
  githubSender,
  githubThreadKey,
  headerKey,
  verifyGithubSignature,
  webhookAuthKinds,
  type WebhookAuth,
} from "./trigger-webhooks";
import { decryptSecretText, encryptSecretText } from "@/lib/security/secrets";
import { A2A_LIMITS } from "@/lib/a2a/model";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
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
const triggerIncludes = {
  deliveryConnection: { select: deliveryConnectionSelect },
  connection: {
    select: { id: true, name: true, status: true, accountLabel: true },
  },
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
  if (value === undefined)
    return { deliveryConnectionId: undefined, deliveryChatId: undefined };
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
const webhookSchema = z
  .object({
    auth: z.enum(webhookAuthKinds),
    ignoredSenders: z
      .array(z.string().trim().min(1).max(100))
      .max(20)
      .optional(),
  })
  .strict();

/** A new one-time secret in the storage form its auth mode verifies. */
function webhookSecretData(auth: WebhookAuth) {
  const secret = newTriggerSecret();
  return {
    secret: secret.secret,
    data:
      auth === "github"
        ? { secretHash: null, webhookSecret: encryptSecretText(secret.secret) }
        : { secretHash: secret.secretHash, webhookSecret: Prisma.DbNull },
  };
}
const ignoredSenders = (logins: string[] | undefined) =>
  logins === undefined
    ? undefined
    : [...new Set(logins.map((login) => login.toLowerCase()))];

const createSchema = z
  .object({
    kind: z.enum(["schedule", "webhook", ...sourceKinds]),
    sourceConfig: z.unknown().optional(),
    connectionId: z.unknown().optional(),
    webhook: webhookSchema.optional(),
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
async function sourceData(
  workspaceId: string,
  kind: string,
  raw: unknown,
  connectionId: unknown,
) {
  if (!isSourceKind(kind))
    return raw === undefined && connectionId === undefined
      ? { sourceConfig: undefined, connectionId: undefined }
      : jsonError("INVALID_TRIGGER_SOURCE", 400);
  if (
    connectionId != null &&
    (typeof connectionId !== "string" ||
      !connectionId ||
      connectionId.length > 200)
  )
    return jsonError("INVALID_TRIGGER_SOURCE", 400);
  const id = typeof connectionId === "string" ? connectionId : null;
  const sourceConfig = parseSourceConfig(kind, raw);
  if (!sourceConfig) return jsonError("INVALID_TRIGGER_SOURCE", 400);
  if (id) {
    const connection = await db.accountConnection.findFirst({
      where: { id, workspaceId },
      select: { config: true },
    });
    if (!connection) return jsonError("INVALID_TRIGGER_SOURCE", 400);
    if (
      !permitsHost(
        configSchema.parse(connection.config),
        new URL(sourceConfig.url),
      )
    )
      return jsonError("TRIGGER_SOURCE_HOST_NOT_ALLOWED", 400);
  }
  return { sourceConfig, connectionId: id };
}
const budgetSchema = z
  .object({
    monthlyUsd: z.number().finite().min(0).max(1_000_000_000).nullable(),
  })
  .strict();
const jsonError = (error: string, status: number) =>
  Response.json({ error }, { status });
function apiFailure(error: unknown) {
  if (error instanceof SourceFailure)
    return jsonError(
      error.code,
      error.code === "SUBSCRIPTION_RATE_LIMITED" ? 429 : 502,
    );
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
      workspace: workspaceAccessWhere(user.id),
    },
  });
  if (!agent) return jsonError("Not found", 404);
  const scope = await resolveWorkspaceScope(
    { id: agent.workspaceId },
    user.id,
    req.method === "GET" ? "read" : "manage",
  );
  if (!scope) return jsonError("Forbidden", 403);
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
      where: { agentId, workspace: workspaceScopeWhere(scope) },
      orderBy: { createdAt: "asc" },
      include: triggerIncludes,
    });
    return Response.json({ triggers: triggers.map(triggerDto) });
  }
  const trigger = triggerId
    ? await db.agentTrigger.findFirst({
        where: {
          id: triggerId,
          agentId,
          workspace: workspaceScopeWhere(scope),
        },
        include: triggerIncludes,
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
    await db.agentTrigger.delete({
      where: { id: trigger.id, workspace: workspaceScopeWhere(scope) },
    });
    return new Response(null, { status: 204 });
  }
  if (req.method === "POST") {
    const body = await parseJson(req, createSchema, 64 * 1024);
    if (!body.ok)
      return jsonError(
        "INVALID_TRIGGER",
        body.reason === "too_large" ? 413 : 400,
      );
    const { delivery, sourceConfig, connectionId, webhook, ...value } =
      body.value;
    if (webhook && value.kind !== "webhook")
      return jsonError("INVALID_TRIGGER", 400);
    const source = await sourceData(
      agent.workspaceId,
      value.kind,
      sourceConfig,
      connectionId,
    );
    if (source instanceof Response) return source;
    const target = await deliveryData(delivery, agent.workspaceId, agentId);
    if (!target) return jsonError("INVALID_TRIGGER_DELIVERY", 400);
    let nextRunAt: Date | null = null;
    try {
      if (value.kind !== "webhook") {
        if (
          isSourceKind(value.kind) &&
          (!value.cron?.trim() || !value.timezone?.trim())
        )
          return jsonError("INVALID_TRIGGER", 400);
        nextRunAt = nextTriggerRun(value.cron ?? "", value.timezone ?? "UTC");
      }
    } catch {
      return jsonError("INVALID_TRIGGER", 400);
    }
    const auth = webhook?.auth ?? "bearer";
    const secret = value.kind === "webhook" ? webhookSecretData(auth) : null;
    const created = await db.agentTrigger.create({
      data: {
        ...value,
        ...target,
        sourceConfig: source.sourceConfig,
        connectionId: source.connectionId ?? null,
        cron: value.kind !== "webhook" ? value.cron : null,
        timezone: value.kind !== "webhook" ? (value.timezone ?? "UTC") : null,
        nextRunAt: value.enabled === false ? null : nextRunAt,
        workspaceId: agent.workspaceId,
        agentId,
        actorId: user.id,
        ...(secret
          ? {
              ...secret.data,
              webhookAuth: auth,
              webhookIgnoredSenders: ignoredSenders(webhook?.ignoredSenders),
            }
          : {}),
      },
      include: triggerIncludes,
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
    const {
      rotateSecret,
      delivery,
      sourceConfig,
      connectionId,
      webhook,
      ...value
    } = body.value;
    const source = await sourceData(
      agent.workspaceId,
      trigger.kind,
      sourceConfig === undefined && isSourceKind(trigger.kind)
        ? trigger.sourceConfig
        : sourceConfig,
      connectionId === undefined && isSourceKind(trigger.kind)
        ? trigger.connectionId
        : connectionId,
    );
    if (source instanceof Response) return source;
    const resetSource =
      (connectionId !== undefined && connectionId !== trigger.connectionId) ||
      (isSourceKind(trigger.kind) &&
        sourceConfig !== undefined &&
        JSON.stringify(parseSourceConfig(trigger.kind, sourceConfig)) !==
          JSON.stringify(
            parseSourceConfig(trigger.kind, trigger.sourceConfig),
          ));
    const target = await deliveryData(delivery, agent.workspaceId, agentId);
    if (!target) return jsonError("INVALID_TRIGGER_DELIVERY", 400);
    if (trigger.kind !== "webhook" && (rotateSecret || webhook))
      return jsonError("INVALID_TRIGGER", 400);
    if (
      trigger.kind === "webhook" &&
      (value.cron !== undefined || value.timezone !== undefined)
    )
      return jsonError("INVALID_TRIGGER", 400);
    let nextRunAt = trigger.nextRunAt;
    try {
      if (trigger.kind === "schedule" || isSourceKind(trigger.kind)) {
        if (
          isSourceKind(trigger.kind) &&
          (!(value.cron ?? trigger.cron)?.trim() ||
            !(value.timezone ?? trigger.timezone)?.trim())
        )
          return jsonError("INVALID_TRIGGER", 400);
        const next = nextTriggerRun(
          value.cron ?? trigger.cron ?? "",
          value.timezone ?? trigger.timezone ?? "UTC",
        );
        nextRunAt = (value.enabled ?? trigger.enabled) ? next : null;
      }
    } catch {
      return jsonError("INVALID_TRIGGER", 400);
    }
    const auth = webhook?.auth ?? trigger.webhookAuth;
    const secret =
      rotateSecret || auth !== trigger.webhookAuth
        ? webhookSecretData(auth === "github" ? "github" : "bearer")
        : null;
    const [updated] = await db.agentTrigger.updateManyAndReturn({
      where: {
        id: trigger.id,
        agentId,
        workspace: workspaceScopeWhere(scope),
        updatedAt: trigger.updatedAt,
      },
      data: {
        ...value,
        ...target,
        ...source,
        ...(resetSource
          ? {
              syncCursor: null,
              lastSyncAt: null,
              lastSyncStatus: null,
              lastSyncError: null,
              syncRetryAt: null,
              syncFailures: 0,
            }
          : {}),
        nextRunAt,
        ...(webhook
          ? {
              webhookAuth: auth,
              webhookIgnoredSenders: ignoredSenders(webhook.ignoredSenders),
            }
          : {}),
        ...(secret ? secret.data : {}),
      },
      include: triggerIncludes,
    });
    if (!updated) return jsonError("INVALID_TRIGGER", 409);
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
      ...workspaceAccessWhere(user.id),
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
const GITHUB_BODY_BYTES = 1024 * 1024;
const BEARER_BODY_BYTES = 64 * 1024;

export async function handleTriggerWebhook(req: Request, triggerId: string) {
  const trigger = await db.agentTrigger.findUnique({
    where: { id: triggerId },
  });
  if (trigger?.kind !== "webhook") return jsonError("Unauthorized", 401);
  const github = trigger.webhookAuth === "github";
  if (!github) {
    const bearer =
      /^Bearer ([^\s]+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ??
      "";
    if (!verifyTriggerSecret(trigger.secretHash, bearer))
      return jsonError("Unauthorized", 401);
  }
  const maxBytes = github ? GITHUB_BODY_BYTES : BEARER_BODY_BYTES;
  if (!requestBodyMayFit(req, maxBytes))
    return jsonError("INVALID_TRIGGER", 413);
  const raw = await readRequestText(req, maxBytes).catch(() => null);
  if (!raw) return jsonError("INVALID_TRIGGER", 400);
  if (!raw.ok) return jsonError("INVALID_TRIGGER", 413);
  // GitHub signs the exact body, so its signature is the authentication.
  if (
    github &&
    (!trigger.webhookSecret ||
      !verifyGithubSignature(
        decryptSecretText(trigger.webhookSecret),
        raw.text,
        req.headers.get("x-hub-signature-256"),
      ))
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
    let payload: unknown;
    try {
      payload = raw.text ? JSON.parse(raw.text) : undefined;
    } catch {
      return jsonError("INVALID_TRIGGER", 400);
    }
    let input: { dedupeKey: string; threadKey: string | null; prompt: string };
    if (github) {
      const event = headerKey(req.headers.get("x-github-event"));
      const delivery = headerKey(req.headers.get("x-github-delivery"));
      if (!event || !delivery) return jsonError("INVALID_TRIGGER", 400);
      if (event === "ping")
        return Response.json({ status: "ignored", conversationId: null });
      const sender = githubSender(payload);
      if (
        sender.bot ||
        (sender.login &&
          trigger.webhookIgnoredSenders.includes(sender.login.toLowerCase()))
      )
        return Response.json(
          { status: "ignored", conversationId: null },
          { status: 202 },
        );
      input = {
        dedupeKey: `github:${delivery}`,
        threadKey: githubThreadKey(payload),
        prompt: triggerPrompt(
          trigger,
          githubPromptPayload(event, payload),
          event,
        ),
      };
    } else {
      input = {
        dedupeKey:
          headerKey(req.headers.get("idempotency-key")) ?? randomUUID(),
        threadKey: headerKey(req.headers.get("x-toolplane-thread-key")),
        prompt: triggerPrompt(trigger, payload),
      };
    }
    if (input.prompt.length > A2A_LIMITS.inputCharacters)
      return jsonError("TRIGGER_PROMPT_TOO_LARGE", 413);
    return Response.json(await acceptTriggerEvent(trigger, input), {
      status: 202,
    });
  } catch (error) {
    return apiFailure(error);
  }
}
