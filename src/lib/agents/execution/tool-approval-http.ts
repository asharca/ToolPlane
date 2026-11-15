import "server-only";
import { db } from "@/lib/db";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getAgentForRequest } from "@/lib/agents/queries";
import { agentRuntimeTokenFromRequest } from "@/lib/agents/runtime-access";
import { parseJson } from "@/lib/agents/public-api/body";
import { originFromRequest } from "@/lib/http/origin";
import { WindowLimiter } from "@/lib/a2a/transport-limits";
import {
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { withLogContext } from "@/lib/observability/context";
import {
  RuntimeToolApprovalInput,
  ToolApprovalResponse,
  runtimeToolApproval,
  decideToolApproval,
  pendingToolApprovals,
} from "./tool-approvals";
import { notifyTaskOutput } from "./live-output";
const limiter = new WindowLimiter(600, 4096);
const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      vary: "Cookie, Authorization",
    },
  });
const failure = (error: unknown) =>
  reply(
    { error: "TOOL_APPROVAL_UNAVAILABLE" },
    error instanceof TaskNotFoundError
      ? 404
      : error instanceof UnsupportedOperationError
        ? 409
        : 500,
  );

export async function handleRuntimeToolApproval(req: Request, taskId: string) {
  return withLogContext({ suppressPayload: true }, async () => {
    try {
      if (req.headers.has("origin"))
        return reply({ error: "RUNTIME_CREDENTIAL_REQUIRED" }, 403);
      const token = await agentRuntimeTokenFromRequest(req);
      if (!token || token.a2aTaskId !== taskId)
        return reply({ error: "RUNTIME_CREDENTIAL_REQUIRED" }, 401);
      limiter.take(`${taskId}:${token.a2aLeaseToken}`);
      if (
        req.headers.get("content-type")?.split(";")[0].trim() !==
        "application/json"
      )
        return reply({ error: "EXPECTED_JSON" }, 415);
      const input = await parseJson(req, RuntimeToolApprovalInput, 262_144);
      if (!input.ok)
        return reply(
          { error: "INVALID_TOOL_APPROVAL" },
          input.reason === "too_large" ? 413 : 400,
        );
      return reply(await runtimeToolApproval(token, input.value));
    } catch (error) {
      return failure(error);
    }
  });
}

export async function handleConversationToolApprovals(
  req: Request,
  agentId: string,
  conversationId: string,
) {
  return withLogContext({ suppressPayload: true }, async () => {
    try {
      const user = await resolveRequestUser(req);
      if (
        !user ||
        !(await db.user.count({ where: { id: user.id, status: "active" } }))
      )
        return reply({ error: "UNAUTHORIZED" }, 401);
      if (
        req.method !== "GET" &&
        !req.headers.has("authorization") &&
        req.headers.get("origin") !== originFromRequest(req)
      )
        return reply({ error: "SAME_ORIGIN_REQUIRED" }, 403);
      const agent = await getAgentForRequest(agentId, user.id);
      if (
        !agent ||
        !(await db.conversation.count({
          where: {
            id: conversationId,
            agentId,
            agent: { workspaceId: agent.workspaceId },
          },
        }))
      )
        return reply({ error: "NOT_FOUND" }, 404);
      if (req.method === "POST") {
        if (
          req.headers.get("content-type")?.split(";")[0].trim() !==
          "application/json"
        )
          return reply({ error: "EXPECTED_JSON" }, 415);
        const input = await parseJson(req, ToolApprovalResponse, 4096);
        if (!input.ok) return reply({ error: "INVALID_TOOL_APPROVAL" }, 400);
        const taskId = await decideToolApproval({
          ...input.value,
          workspaceId: agent.workspaceId,
          agentId,
          conversationId,
          actorId: user.id,
        });
        notifyTaskOutput(taskId);
        return reply({ ok: true });
      }
      const tasks = await db.a2ATask.findMany({
        where: {
          context: { workspaceId: agent.workspaceId, agentId },
          toolApprovals: { some: { conversationId, status: "pending" } },
          phase: "executing",
          cancelRequestedAt: null,
          deadlineAt: { gt: new Date() },
        },
        select: { id: true, leaseToken: true },
        take: 32,
      });
      const toolApprovals = (
        await Promise.all(
          tasks.map((task) => pendingToolApprovals(task.id, task.leaseToken)),
        )
      ).flat();
      return reply({
        toolApprovals,
        dataParts: toolApprovals.map((card) => ({
          type: "data-tool-approval",
          id: card.id,
          data: card,
        })),
      });
    } catch (error) {
      return failure(error);
    }
  });
}
