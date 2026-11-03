import "server-only";
import { Task } from "@a2a-js/sdk";
import {
  RequestMalformedError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { db } from "@/lib/db";
import { resolveRequestPrincipal } from "@/lib/auth/request-user";
import { getAgentForRequest } from "@/lib/agents/queries";
import { AgentRevisionError } from "@/lib/agents/revisions";
import { parseJson } from "@/lib/agents/public-api/body";
import { runtimeEnv } from "@/lib/runtime-env";
import { originFromRequest } from "@/lib/http/origin";
import { withLogContext } from "@/lib/observability/context";
import { isLocalGrant, type TaskGrant } from "@/lib/a2a/principal";
import { NativeUiResponse, NativeUiProjectionLimitError } from "./native-ui";
import { readTaskUi, respondTaskUi } from "./task-ui";
import { uiStatus } from "./ui-http";

const failureCodes: Record<string, true> = {
  PI_SANDBOX_BUSY: true,
  PI_STORAGE_QUOTA_EXCEEDED: true,
  PI_EXECUTION_FAILED: true,
  PI_SESSION_MISSING: true,
  PI_SESSION_CORRUPT: true,
  PI_MODEL_UNAVAILABLE: true,
  PI_INPUT_INVALID: true,
  PI_CONFIG_INVALID: true,
  PI_PROCESS_STOP_UNCONFIRMED: true,
  PI_NODE_UNSUPPORTED: true,
  PI_SQLITE_UNAVAILABLE: true,
  PI_HARNESS_VERSION_MISMATCH: true,
  PI_RECOVERY_CHECK_FAILED: true,
  PI_PROTOCOL_ERROR: true,
  PI_TARGET_UNAVAILABLE: true,
  PI_OUTPUT_TRUNCATED: true,
  PI_SDK_REQUEST_FAILED: true,
  MCP_UNREACHABLE: true,
  MCP_GRANT_REVOKED: true,
  MCP_TOOL_FORBIDDEN: true,
};
function executionErrorCode(snapshot: unknown) {
  const task = Task.fromJSON(snapshot);
  for (const part of task.status?.message?.parts ?? []) {
    if (part.content?.$case !== "text") continue;
    const code = part.content.value.split(":", 1)[0];
    if (Object.hasOwn(failureCodes, code)) return code;
  }
  return "AGENT_EXECUTION_FAILED";
}
const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      vary: "Cookie, Authorization",
    },
  });

// A browser BFF, not a runtime/Toolkit authorization surface. Explicit credentials
// never fall back to a more powerful ambient cookie, including on read requests.
async function sessionUser(req: Request) {
  if (req.headers.has("authorization")) return null;
  const principal = await resolveRequestPrincipal(req);
  return principal?.credential === "session" ? principal.user : null;
}
function sameOrigin(req: Request) {
  const site = req.headers.get("sec-fetch-site");
  if (site && !["same-origin", "none"].includes(site)) return false;
  const origin = req.headers.get("origin");
  if (req.method === "GET" && origin === null) return true;
  const configured = new URL(
    runtimeEnv("NEXT_PUBLIC_APP_URL") || "http://localhost:3000",
  );
  if (
    !["https:", "http:"].includes(configured.protocol) ||
    configured.username ||
    configured.password ||
    configured.search ||
    configured.hash
  )
    return false;
  return origin === originFromRequest(req);
}

export async function handleConversationExecution(
  req: Request,
  agentId: string,
  conversationId: string,
) {
  return withLogContext({ suppressPayload: true }, async () => {
    try {
      if (!["GET", "POST"].includes(req.method))
        return reply({ error: "Method not allowed." }, 405);
      const user = await sessionUser(req);
      if (!user) return reply({ error: "Unauthorized" }, 401);
      if (!sameOrigin(req))
        return reply({ error: "Same-origin request required." }, 403);
      if (new URL(req.url).search)
        return reply(
          { error: "Execution identifiers are derived from the conversation." },
          400,
        );
      const agent = await getAgentForRequest(agentId, user.id);
      if (!agent) return reply({ error: "Conversation not found." }, 404);
      const conversation = await db.conversation.findFirst({
        where: {
          id: conversationId,
          agentId,
          agent: { workspaceId: agent.workspaceId },
        },
        select: { id: true },
      });
      if (!conversation)
        return reply({ error: "Conversation not found." }, 404);
      const workspace = await db.workspace.findUniqueOrThrow({
        where: { id: agent.workspaceId },
        select: { slug: true },
      });
      const active = await db.user.count({
        where: { id: user.id, status: "active" },
      });
      if (!active) return reply({ error: "Unauthorized" }, 401);
      const binding = await db.a2AEntryBinding.findFirst({
        where: {
          sourceId: conversation.id,
          kind: { in: ["chat", "channel", "control"] },
          context: {
            workspaceId: agent.workspaceId,
            agentId,
            targetKind: "local",
          },
        },
        include: { lastTask: true },
        orderBy: [{ lastTask: { createdAt: "desc" } }, { id: "desc" }],
      });
      if (!binding)
        return req.method === "GET"
          ? reply({ execution: null })
          : reply({ error: "Execution not found." }, 404);
      const task = binding.lastTask;
      const grant = task.grant as unknown as TaskGrant;
      if (
        !isLocalGrant(grant) ||
        grant.workspaceId !== agent.workspaceId ||
        grant.agentId !== agentId ||
        grant.entryPolicy?.sourceId !== conversation.id ||
        grant.entryPolicy.kind !== binding.kind ||
        grant.entryPolicy.sourceAgentId !== agentId ||
        task.parentTaskId ||
        task.rootTaskId !== task.id
      )
        return reply({ error: "Execution not found." }, 404);
      if (grant.actorId !== user.id)
        return reply(
          {
            error:
              "Only the execution owner can view or answer its native dialogs.",
          },
          403,
        );
      const ctx = {
        workspaceId: agent.workspaceId,
        actorId: user.id,
        agentId,
        slug: workspace.slug,
      };
      if (req.method === "POST") {
        if (
          req.headers
            .get("content-type")
            ?.split(";")[0]
            .trim()
            .toLowerCase() !== "application/json"
        )
          return reply({ error: "Expected JSON." }, 415);
        const parsed = await parseJson(req, NativeUiResponse, 262_144);
        if (!parsed.ok)
          return reply(
            { error: "Invalid native UI response." },
            parsed.reason === "too_large" ? 413 : 400,
          );
        await respondTaskUi(ctx, task.id, task.id, parsed.value);
        return reply({ ok: true });
      }
      const { row: _row, ...projection } = await readTaskUi(
        ctx,
        task.id,
        task.id,
      );
      const status = uiStatus(
        task.state,
        task.phase,
        projection.uiRequests.length > 0,
      );
      return reply({
        execution: {
          id: task.id,
          status,
          ...(status === "failed"
            ? {
                error: {
                  code: executionErrorCode(task.snapshot),
                  message:
                    "执行未能完成。请检查模型或工具连接后再发送新消息；本次执行不会自动重试。",
                },
              }
            : {}),
          ...projection,
        },
      });
    } catch (error) {
      const status =
        error instanceof NativeUiProjectionLimitError
          ? 413
          : error instanceof TaskNotFoundError
            ? 404
            : error instanceof RequestMalformedError
              ? 400
              : error instanceof AgentRevisionError
                ? 403
                : error instanceof UnsupportedOperationError
                  ? 409
                  : 500;
      return reply(
        {
          error:
            "Execution could not be read or updated. Refresh the conversation and try again.",
        },
        status,
      );
    }
  });
}
