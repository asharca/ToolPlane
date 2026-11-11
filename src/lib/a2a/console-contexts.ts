import "server-only";
import { Role, SendMessageRequest, Task } from "@a2a-js/sdk";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import type { ConsoleActor } from "./console-service";
import { getConsoleTaskTree, type ConsoleTaskTree } from "./console-tasks";
import { jsonTask } from "./model";
import { assertLocalActor } from "./local-policy";
import {
  A2AHttpError,
  isLocalGrant,
  isWorkspaceGrant,
  type TaskGrant,
} from "./principal";

const PAGE_SIZE = 20;
const Cursor = z
  .object({
    contextId: z.string().min(1).max(200),
    updatedAt: z.iso.datetime(),
  })
  .strict();
type ContextCursor = z.infer<typeof Cursor>;
export type ConsoleContext = {
  contextId: string;
  peer: { kind: "agent" | "remote" | "client"; name: string };
  title: string;
  state: string;
  updatedAt: string;
  tasks: Array<{
    taskId: string;
    rootTaskId: string;
    rootAgentId: string;
    createdAt: string;
  }>;
};

function decodeCursor(value?: string): ContextCursor | undefined {
  if (!value) return undefined;
  try {
    return Cursor.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw new A2AHttpError(400, "Invalid context query.");
  }
}

/** Ordinary entry roots have separate navigation; published clients are A2A peers. */
function inbound(grant: TaskGrant, parentTaskId: string | null) {
  return (
    !isWorkspaceGrant(grant) || Boolean(parentTaskId) || !grant.entryPolicy
  );
}

/** Read-only ledger projection. Every task still enters through its authorized root tree. */
export async function getConsoleContexts(
  ctx: ConsoleActor,
  query: { taskId?: string; cursor?: string } = {},
): Promise<{ items: ConsoleContext[]; nextCursor: string | null }> {
  await assertLocalActor(db, ctx.workspaceId, ctx.actorId);
  let cursor = decodeCursor(query.cursor);
  const owned: Prisma.A2ATaskWhereInput = {
    context: {
      workspaceId: ctx.workspaceId,
      OR: [
        { targetKind: "local", agentId: ctx.agentId },
        {
          targetKind: "published",
          endpoint: {
            workspaceId: ctx.workspaceId,
            sourceAgentId: ctx.agentId,
          },
        },
      ],
      expiresAt: { gt: new Date() },
      // Ordinary entry contexts already have their own navigation. Delegated
      // children execute in separate contexts and remain eligible.
      entryBindings: {
        none: {
          kind: { in: ["chat", "channel", "work", "trigger", "control"] },
        },
      },
    },
    grant: { path: ["workspaceId"], equals: ctx.workspaceId },
  };
  const trees = new Map<
    string,
    { rootAgentId: string; tree: ConsoleTaskTree }
  >();
  async function authorize(row: {
    id: string;
    rootTaskId: string | null;
    grant: Prisma.JsonValue;
  }) {
    const grant = row.grant as unknown as TaskGrant;
    if (!grant || grant.workspaceId !== ctx.workspaceId) return null;
    const rootTaskId =
      row.rootTaskId ?? (!isWorkspaceGrant(grant) ? row.id : null);
    if (!rootTaskId) return null;
    let authorized = trees.get(rootTaskId);
    if (!authorized) {
      const root = await db.a2ATask.findFirst({
        where: {
          id: rootTaskId,
          parentTaskId: null,
          context: { workspaceId: ctx.workspaceId },
        },
        select: {
          context: {
            select: {
              agentId: true,
              endpoint: { select: { sourceAgentId: true } },
            },
          },
        },
      });
      const rootAgentId =
        root?.context.agentId ?? root?.context.endpoint?.sourceAgentId;
      if (!rootAgentId) return null;
      try {
        authorized = {
          rootAgentId,
          tree: await getConsoleTaskTree(
            { ...ctx, agentId: rootAgentId },
            rootTaskId,
            row.id,
          ),
        };
        trees.set(rootTaskId, authorized);
      } catch (error) {
        if (error instanceof TaskNotFoundError) return null;
        throw error;
      }
    }
    // The cached tree was produced by getConsoleTaskTree, never by trusting grant child IDs.
    return authorized.tree.nodes.some((node) => node.id === row.id)
      ? authorized
      : null;
  }

  let contextId: string | undefined;
  if (query.taskId) {
    const task = await db.a2ATask.findFirst({
      where: { ...owned, id: query.taskId },
    });
    if (
      !task ||
      !inbound(task.grant as unknown as TaskGrant, task.parentTaskId) ||
      !(await authorize(task))
    )
      return { items: [], nextCursor: null };
    contextId = task.contextId;
  }

  async function project(id: string): Promise<ConsoleContext | null> {
    const [first, recent, updated] = await Promise.all([
      db.a2ATask.findFirst({
        where: { ...owned, contextId: id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      db.a2ATask.findMany({
        where: { ...owned, contextId: id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: PAGE_SIZE,
      }),
      db.a2ATask.findFirst({
        where: { ...owned, contextId: id },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      }),
    ]);
    if (
      !first ||
      !inbound(first.grant as unknown as TaskGrant, first.parentTaskId) ||
      !(await authorize(first)) ||
      !updated ||
      !(await authorize(updated))
    )
      return null;
    const tasks: ConsoleContext["tasks"] = [];
    let latest: (typeof recent)[number] | undefined;
    for (const row of recent) {
      if (!inbound(row.grant as unknown as TaskGrant, row.parentTaskId))
        continue;
      const authority = await authorize(row);
      if (!authority) continue;
      tasks.push({
        taskId: row.id,
        rootTaskId: authority.tree.rootTaskId,
        rootAgentId: authority.rootAgentId,
        createdAt: row.createdAt.toISOString(),
      });
      latest ??= row;
    }
    if (!latest || !tasks.length) return null;
    const grant = first.grant as unknown as TaskGrant;
    // Local incoming delegation identifies the sender by the final verified ancestor.
    // A console RPC root has no sending agent or API client: label that browser client explicitly.
    const sourceAgentId = isLocalGrant(grant)
      ? grant.ancestorAgentIds.at(-1)
      : undefined;
    const sender = sourceAgentId
      ? await db.agent.findFirst({
          where: { id: sourceAgentId, workspaceId: ctx.workspaceId },
          select: { name: true },
        })
      : null;
    const message = SendMessageRequest.fromJSON(first.request).message;
    const title =
      message?.role === Role.ROLE_USER
        ? message.parts.find((part) => part.content?.$case === "text")?.content
            ?.value
        : undefined;
    const status = jsonTask(Task.fromJSON(latest.snapshot)).status as
      | { state?: string }
      | undefined;
    return {
      contextId: id,
      peer: sender
        ? { kind: "agent", name: sender.name }
        : {
            kind: "client",
            name: isWorkspaceGrant(grant) ? "Console" : "API client",
          },
      title: typeof title === "string" ? title.trim().slice(0, 120) : "",
      state: status?.state ?? "TASK_STATE_UNSPECIFIED",
      updatedAt: updated.updatedAt.toISOString(),
      tasks: tasks.reverse(),
    };
  }

  if (contextId) {
    const item = await project(contextId);
    return { items: item ? [item] : [], nextCursor: null };
  }
  const items: ConsoleContext[] = [];
  // Filtered groups are skipped, so cap scanned batches and hand back a cursor.
  for (let batch = 0; ; batch++) {
    if (batch === 5 && cursor)
      return {
        items,
        nextCursor: Buffer.from(JSON.stringify(cursor)).toString("base64url"),
      };
    const groups = await db.a2ATask.groupBy({
      by: ["contextId"],
      where: owned,
      _max: { updatedAt: true },
      orderBy: [{ _max: { updatedAt: "desc" } }, { contextId: "desc" }],
      ...(cursor
        ? {
            having: {
              OR: [
                { updatedAt: { _max: { lt: new Date(cursor.updatedAt) } } },
                {
                  updatedAt: { _max: { equals: new Date(cursor.updatedAt) } },
                  contextId: { lt: cursor.contextId },
                },
              ],
            },
          }
        : {}),
      take: PAGE_SIZE + 1,
    });
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      if (!group._max.updatedAt) continue;
      cursor = {
        contextId: group.contextId,
        updatedAt: group._max.updatedAt.toISOString(),
      };
      const item = await project(group.contextId);
      if (item) items.push(item);
      if (items.length === PAGE_SIZE)
        return {
          items,
          nextCursor:
            index < groups.length - 1 || groups.length === PAGE_SIZE + 1
              ? Buffer.from(JSON.stringify(cursor)).toString("base64url")
              : null,
        };
    }
    if (groups.length < PAGE_SIZE + 1) return { items, nextCursor: null };
  }
}
