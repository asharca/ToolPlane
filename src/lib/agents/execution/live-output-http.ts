import "server-only";
import { z } from "zod";
import {
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { db } from "@/lib/db";
import { resolveRequestPrincipal } from "@/lib/auth/request-user";
import { getAgentForRequest } from "@/lib/agents/queries";
import { AgentRevisionError } from "@/lib/agents/revisions";
import { originFromRequest } from "@/lib/http/origin";
import {
  A2AHttpError,
  isLocalGrant,
  type TaskGrant,
} from "@/lib/a2a/principal";
import { getConsoleTaskTree } from "@/lib/a2a/console-tasks";
import { sessionActor } from "@/lib/a2a/console-http";
import { withLogContext } from "@/lib/observability/context";
import { readTaskOutput } from "./live-output-read";
import {
  executionOutputResponse,
  type Observation,
} from "./live-output-stream";

const reply = (body: unknown, status: number) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      vary: "Cookie, Authorization",
    },
  });
function failure(error: unknown) {
  if (error instanceof A2AHttpError)
    return reply({ error: error.message }, error.status);
  if (error instanceof TaskNotFoundError)
    return reply({ error: "Execution not found." }, 404);
  return reply({ error: "Execution could not be observed." }, 500);
}
async function conversationObservation(
  req: Request,
  agentId: string,
  conversationId: string,
): Promise<Observation> {
  // Observation does not call readTaskUi/respondTaskUi or create an execution grant.
  if (req.headers.has("authorization"))
    throw new A2AHttpError(401, "Use the console session.");
  const site = req.headers.get("sec-fetch-site");
  const origin = req.headers.get("origin");
  if (
    (site && !["same-origin", "none"].includes(site)) ||
    (origin !== null && origin !== originFromRequest(req))
  )
    throw new A2AHttpError(403, "Same-origin request required.");
  const principal = await resolveRequestPrincipal(req);
  if (principal?.credential !== "session")
    throw new A2AHttpError(401, "Unauthorized");
  const userId = principal.user.id;
  if (!(await db.user.count({ where: { id: userId, status: "active" } })))
    throw new A2AHttpError(401, "Unauthorized");
  const agent = await getAgentForRequest(agentId, userId);
  if (!agent) throw new TaskNotFoundError();
  const conversation = await db.conversation.findFirst({
    where: {
      id: conversationId,
      agentId,
      agent: { workspaceId: agent.workspaceId },
      workSession: null,
    },
    select: { id: true },
  });
  if (!conversation) throw new TaskNotFoundError();
  const binding = await db.a2AEntryBinding.findFirst({
    where: {
      sourceId: conversation.id,
      kind: { in: ["chat", "channel", "control", "trigger"] },
      context: { workspaceId: agent.workspaceId, agentId, targetKind: "local" },
    },
    include: { lastTask: true },
    orderBy: [{ lastTask: { createdAt: "desc" } }, { id: "desc" }],
  });
  const observation: Observation = {
    workspaceId: agent.workspaceId,
    userId,
    output: null,
    settled: false,
  };
  if (!binding) return observation;
  const task = binding.lastTask;
  const grant = task.grant as unknown as TaskGrant;
  if (
    !isLocalGrant(grant) ||
    grant.workspaceId !== agent.workspaceId ||
    grant.agentId !== agentId ||
    !grant.entryPolicy ||
    (grant.entryPolicy.conversationId ?? grant.entryPolicy.sourceId) !==
      conversation.id ||
    grant.entryPolicy.kind !== binding.kind ||
    grant.entryPolicy.sourceAgentId !== agentId ||
    grant.ancestorTaskIds.length ||
    task.parentTaskId ||
    task.rootTaskId !== task.id
  )
    throw new TaskNotFoundError();
  // Ordinary channel history is workspace-visible, but private native chat/control
  // execution output remains owner-only, just like its console tree.
  if (binding.kind !== "channel" && grant.actorId !== userId)
    throw new TaskNotFoundError();
  const output = readTaskOutput(task);
  const persisted =
    output.done &&
    (await db.message.count({
      where: {
        conversationId,
        role: "assistant",
        createdAt:
          output.startedAt === undefined
            ? undefined
            : { gte: new Date(output.startedAt) },
        parts: {
          array_contains: [
            { type: "data-agent-task", data: { taskId: task.id } },
          ],
        },
      },
    }));
  return { ...observation, output, settled: Boolean(persisted) };
}
export async function handleConversationOutputEvents(
  req: Request,
  agentId: string,
  conversationId: string,
) {
  return withLogContext({ suppressPayload: true }, async () => {
    try {
      if (req.method !== "GET")
        return reply({ error: "Method not allowed." }, 405);
      if (new URL(req.url).search)
        throw new A2AHttpError(400, "Conversation determines the execution.");
      const load = () => conversationObservation(req, agentId, conversationId);
      return executionOutputResponse(req, await load(), load, true);
    } catch (error) {
      return failure(error);
    }
  });
}
export async function handleConsoleOutputEvents(
  req: Request,
  slug: string,
  agentId: string,
) {
  return withLogContext({ suppressPayload: true }, async () => {
    try {
      if (req.method !== "GET")
        return reply({ error: "Method not allowed." }, 405);
      const query = new URL(req.url).searchParams;
      if ([...query.keys()].some((key) => query.getAll(key).length !== 1))
        throw new A2AHttpError(400, "Invalid task query.");
      const parsed = z
        .object({
          rootTaskId: z.string().min(1).max(200),
          selectedTaskId: z.string().min(1).max(200).optional(),
        })
        .strict()
        .safeParse(Object.fromEntries(query));
      if (!parsed.success) throw new A2AHttpError(400, "Invalid task query.");
      const rootId = parsed.data.rootTaskId,
        selectedId = parsed.data.selectedTaskId ?? rootId;
      const load = async (): Promise<Observation> => {
        const ctx = await sessionActor(req, slug, agentId);
        // EXACT same selected/root visibility, edges, remote binding and actor
        // restrictions as the console history API; no ID-only authorization.
        try {
          await getConsoleTaskTree(ctx, rootId, selectedId, 0);
        } catch (error) {
          if (
            error instanceof UnsupportedOperationError ||
            error instanceof AgentRevisionError
          )
            throw new TaskNotFoundError();
          throw error;
        }
        const row = await db.a2ATask.findFirst({
          where: {
            id: selectedId,
            rootTaskId: rootId,
            context: { workspaceId: ctx.workspaceId },
          },
        });
        if (!row) throw new TaskNotFoundError();
        const output = readTaskOutput(row);
        return {
          workspaceId: ctx.workspaceId,
          userId: ctx.actorId,
          output,
          settled: output.done,
        };
      };
      return executionOutputResponse(req, await load(), load);
    } catch (error) {
      return failure(error);
    }
  });
}
