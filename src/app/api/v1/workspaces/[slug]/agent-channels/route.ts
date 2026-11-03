import { systemLog } from "@/lib/observability/system";
import { withRequestLogging } from "@/lib/observability/http";
import { writeAudit } from "@/lib/observability/audit";
import { z } from "zod";
import { resolveAccountRequestUser } from "@/lib/auth/request-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { db } from "@/lib/db";
import { ORDINARY_AGENT_FILTER } from "@/lib/agents/queries";
import {
  createAgentChannelConnection,
  deleteAgentChannelConnection,
  getAgentChannelConnection,
  listAgentChannelConnections,
  updateAgentChannelConnectionCredentials,
  moveAgentChannelConnection,
} from "@/lib/agents/channel-connections";
import {
  getChannelSandbox,
  listChannelSandboxes,
} from "@/lib/agents/channel-sandboxes";
import { toAgentChannelConnectionClientView } from "@/lib/agents/channel-connection-client";
import {
  liveAgentChannelStatus,
  startAgentChannelRunner,
  stopAgentChannelRunner,
} from "@/lib/agents/channel-runtime";
import {
  clearAgentChannelLogs,
  getPersistedAgentChannelLogs,
} from "@/lib/agents/channel-runtime-logs";
import {
  checkAgentChannelPairing,
  requestAgentChannelPairing,
} from "@/lib/agents/channel-pairing";
import { getMessagingPlatform } from "@/lib/agents/platforms";
import { hostedRunnerSpec } from "@/lib/agents/platform-runner";

export const runtime = "nodejs";
export const maxDuration = 60;

declare global {
  var __toolplaneChannelCommands: Map<string, Promise<Response>> | undefined;
}

const commandSchema = z
  .object({
    action: z.enum([
      "create",
      "update",
      "delete",
      "start",
      "stop",
      "pair",
      "check",
      "move",
    ]),
    connectionId: z.string().min(1).max(200).optional(),
    platform: z.string().max(40).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    agentId: z.string().min(1).max(200).nullable().optional(),
    sandboxId: z.string().min(1).max(200).optional(),
    credentials: z.record(z.string().max(80), z.string().max(8000)).default({}),
  })
  .strict()
  .refine((input) => input.action !== "move" || Boolean(input.sandboxId));

async function authorize(req: Request, slug: string, manage = false) {
  const user = await resolveAccountRequestUser(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace)
    return Response.json({ error: "Workspace not found" }, { status: 404 });
  if (
    manage &&
    workspace.ownerId !== user.id &&
    !(await db.membership.count({
      where: { workspaceId: workspace.id, userId: user.id, role: "admin" },
    }))
  )
    return Response.json({ error: "Forbidden" }, { status: 403 });
  return { ...workspace, actorId: user.id };
}

async function channelList(
  workspaceId: string,
  agentId?: string,
  sandboxId?: string,
) {
  return (
    await listAgentChannelConnections(workspaceId, agentId, sandboxId)
  ).map((channel) => ({
    ...toAgentChannelConnectionClientView(channel),
    status: ["running", "starting"].includes(channel.status)
      ? liveAgentChannelStatus(channel.id)
      : channel.status,
  }));
}

export const GET = withRequestLogging(
  "/api/v1/workspaces/[slug]/agent-channels",
  async function GET(
    req: Request,
    { params }: { params: Promise<{ slug: string }> },
  ) {
    const workspace = await authorize(req, (await params).slug);
    if (workspace instanceof Response) return workspace;
    const query = new URL(req.url).searchParams;
    const sandboxId = query.get("sandboxId") || undefined;
    if (sandboxId && !(await getChannelSandbox(workspace.id, sandboxId))) {
      return Response.json({ error: "Sandbox not found" }, { status: 404 });
    }
    const historyId = query.get("history");
    if (historyId) {
      const channel = await db.agentChannelConnection.findFirst({
        where: { id: historyId, workspaceId: workspace.id },
        select: { id: true, agentId: true, sandboxId: true },
      });
      if (!channel || (sandboxId && channel.sandboxId !== sandboxId)) {
        return Response.json({ error: "Channel not found" }, { status: 404 });
      }
      const scope = {
        conversation: {
          agentId: channel.agentId ?? "",
          agent: { workspaceId: workspace.id },
          runtimeSessionKey: { startsWith: `channel:${channel.id}:` },
        },
        role: { in: ["user", "assistant"] },
      };
      const after = query.get("after");
      const before = query.get("before");
      const cursorId = after || before;
      const cursor = cursorId
        ? await db.message.findFirst({
            where: { ...scope, id: cursorId },
            select: { id: true, createdAt: true },
          })
        : null;
      if (cursorId && !cursor) {
        return Response.json({ error: "Message not found" }, { status: 404 });
      }
      const direction = after ? ("asc" as const) : ("desc" as const);
      const rows = await db.message.findMany({
        where: {
          ...scope,
          ...(cursor
            ? {
                OR: [
                  {
                    createdAt: after
                      ? { gt: cursor.createdAt }
                      : { lt: cursor.createdAt },
                  },
                  {
                    createdAt: cursor.createdAt,
                    id: after ? { gt: cursor.id } : { lt: cursor.id },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: direction }, { id: direction }],
        take: 101,
        select: {
          id: true,
          role: true,
          parts: true,
          createdAt: true,
          conversation: { select: { id: true, title: true } },
        },
      });
      const page = rows.slice(0, 100);
      if (!after) page.reverse();
      return Response.json(
        {
          messages: page.map(({ parts, ...row }) => ({
            ...row,
            text: Array.isArray(parts)
              ? parts
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
                  .join("\n\n")
              : "",
          })),
          hasMore: rows.length > 100,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const logId = query.get("logs");
    if (logId) {
      if (!(await getAgentChannelConnection(workspace.id, logId))) {
        return Response.json({ error: "Channel not found" }, { status: 404 });
      }
      return Response.json(
        { logs: await getPersistedAgentChannelLogs(workspace.id, logId) },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const [connections, agents, sandboxes] = await Promise.all([
      channelList(workspace.id, query.get("agentId") || undefined, sandboxId),
      db.agent.findMany({
        where: { workspaceId: workspace.id, ...ORDINARY_AGENT_FILTER },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      listChannelSandboxes(workspace.id),
    ]);
    return Response.json(
      { connections, agents, sandboxes },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
);

export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/agent-channels",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ slug: string }> },
  ) {
    const workspace = await authorize(req, (await params).slug, true);
    if (workspace instanceof Response) return workspace;
    if (
      req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
      "application/json"
    ) {
      return Response.json(
        { error: "Content-Type must be application/json" },
        { status: 415 },
      );
    }
    const parsed = commandSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
      return Response.json(
        { error: "Invalid channel configuration" },
        { status: 400 },
      );
    const input = parsed.data;
    let connectionId = input.connectionId;
    const existing = connectionId
      ? await getAgentChannelConnection(workspace.id, connectionId)
      : null;
    if (input.action !== "create" && !existing) {
      return Response.json({ error: "Channel not found" }, { status: 404 });
    }
    const platform = getMessagingPlatform(
      existing?.platform ?? input.platform ?? "",
    );
    if (
      !platform ||
      (input.action === "create" && !hostedRunnerSpec(platform.slug))
    ) {
      return Response.json(
        { error: "Unsupported channel platform" },
        { status: 400 },
      );
    }
    const invalidField = Object.entries(input.credentials).some(
      ([key, value]) => {
        const field = platform.credentials.find((field) => field.name === key);
        return (
          !field ||
          (value !== "" &&
            ((field.inputType === "boolean" &&
              !["true", "false"].includes(value)) ||
              (field.options &&
                !field.options.some((option) => option.value === value))))
        );
      },
    );
    if (invalidField)
      return Response.json(
        { error: "Invalid channel credentials" },
        { status: 400 },
      );

    const execute = async () => {
      const bindOperator = async (id: string, replace = false) => {
        await db.$transaction(async (tx) => {
          const changed = await tx.agentChannelConnection.updateMany({
            where: {
              id,
              workspaceId: workspace.id,
              ...(replace ? {} : { a2aActorId: null }),
            },
            data: { a2aActorId: workspace.actorId },
          });
          if (changed.count)
            await writeAudit(tx, {
              actorId: workspace.actorId,
              workspaceId: workspace.id,
              action: "agent.channel.operator.bind",
              targetType: "AgentChannelConnection",
              targetId: id,
              changes: { actorId: workspace.actorId },
            });
        });
      };
      if (existing && !["stop", "delete"].includes(input.action)) {
        await bindOperator(existing.id, input.action === "start");
      }
      let result: { error?: string } = {};
      if (input.action === "create") {
        const created = await createAgentChannelConnection({
          workspaceId: workspace.id,
          agentId: input.agentId,
          platform: platform.slug,
          name: input.name,
          credentials: input.credentials,
          draft: true,
          sandboxId: input.sandboxId,
        });
        result = created;
        connectionId = created.connection?.id;
        if (connectionId) {
          await bindOperator(connectionId);
          if (
            platform.slug === "weixin" &&
            created.connection?.agentId &&
            !created.connection.missingStartCredentialNames.length
          ) {
            result = await startAgentChannelRunner(workspace.id, connectionId);
          }
        }
      } else {
        if (!existing)
          return Response.json({ error: "Channel not found" }, { status: 404 });
        const existingConnectionId = existing.id;
        switch (input.action) {
          case "update":
            result = await updateAgentChannelConnectionCredentials({
              workspaceId: workspace.id,
              connectionId: existingConnectionId,
              name: input.name,
              agentId: input.agentId,
              credentials: input.credentials,
            });
            break;
          case "delete":
            await stopAgentChannelRunner(workspace.id, existingConnectionId);
            await deleteAgentChannelConnection(
              workspace.id,
              existingConnectionId,
            );
            clearAgentChannelLogs(existingConnectionId);
            break;
          case "start":
            result = await startAgentChannelRunner(
              workspace.id,
              existingConnectionId,
            );
            break;
          case "stop":
            await stopAgentChannelRunner(workspace.id, existingConnectionId);
            break;
          case "pair":
            result = await requestAgentChannelPairing(
              workspace.id,
              existingConnectionId,
            );
            break;
          case "check":
            result = await checkAgentChannelPairing(
              workspace.id,
              existingConnectionId,
            );
            if (
              !result.error &&
              platform.slug === "weixin" &&
              existing.pairing?.status !== "ready"
            ) {
              const paired = await getAgentChannelConnection(
                workspace.id,
                existingConnectionId,
              );
              if (paired?.pairing?.status === "ready" && paired.agentId) {
                result = await startAgentChannelRunner(
                  workspace.id,
                  existingConnectionId,
                );
              }
            }
            break;
          case "move":
            if (!input.sandboxId)
              return Response.json(
                { error: "Invalid channel configuration" },
                { status: 400 },
              );
            result = await moveAgentChannelConnection(
              workspace.id,
              existingConnectionId,
              input.sandboxId,
            );
            break;
        }
      }
      return Response.json(
        {
          error: result.error,
          connectionId,
          connections: await channelList(workspace.id),
        },
        {
          status: result.error ? 400 : 200,
          headers: { "Cache-Control": "no-store" },
        },
      );
    };

    globalThis.__toolplaneChannelCommands ??= new Map();
    const commands = globalThis.__toolplaneChannelCommands;
    const key = connectionId ?? `${workspace.id}:create`;
    const previous = commands.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(execute);
    commands.set(key, operation);
    try {
      return await operation;
    } catch (error) {
      systemLog("error", "[agent-channels] operation failed", error);
      return Response.json(
        { error: "Channel operation failed" },
        { status: 500 },
      );
    } finally {
      if (commands.get(key) === operation) commands.delete(key);
    }
  },
);
