import {
  agentRuntimeTokenFromRequest,
  bindRuntimeLogContext,
} from "@/lib/agents/runtime-access";
import { resolveAgentRuntimeGrant } from "@/lib/agents/runtime-grant";
import { resolvePinnedAgent } from "@/lib/agents/revisions";
import { getAgentForRun } from "@/lib/agents/queries";
import { NativeApprovalRequest } from "@/lib/a2a/tool-approvals";
import { parseJson } from "@/lib/agents/public-api/body";
import { WindowLimiter } from "@/lib/a2a/transport-limits";
import { withLogContext } from "@/lib/observability/context";

export const runtime = "nodejs";
export const maxDuration = 60;
const limiter = new WindowLimiter(180, 4096);

/** Native Pi awaits this authorization before executing any built-in or extension tool. */
export async function POST(req: Request) {
  return withLogContext({ suppressPayload: true }, async () => {
    const headers = {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    };
    if (req.headers.has("origin"))
      return Response.json(
        { error: "Runtime credential required" },
        { status: 403, headers },
      );
    const token = await agentRuntimeTokenFromRequest(req);
    if (!token || token.a2aTaskId)
      return Response.json(
        { error: "Session runtime credential required" },
        { status: 401, headers },
      );
    if (
      req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
      "application/json"
    ) {
      return Response.json(
        { error: "Expected JSON" },
        { status: 415, headers },
      );
    }
    try {
      limiter.take(
        `${token.agentId}:${token.agentRevisionId}:${token.conversationId ?? token.a2aContextId}`,
      );
      const parsed = await parseJson(req, NativeApprovalRequest, 20_480);
      if (!parsed.ok)
        return Response.json(
          { error: "Invalid native authorization request" },
          { status: parsed.reason === "too_large" ? 413 : 400, headers },
        );
      if (!(await resolveAgentRuntimeGrant(token)))
        return Response.json({ status: "deny" }, { status: 403, headers });
      bindRuntimeLogContext(token);
      const live = await getAgentForRun(token.agentId, token.workspaceId);
      if (!live)
        return Response.json({ status: "deny" }, { status: 403, headers });
      const agent = await resolvePinnedAgent(live, token.agentRevisionId);
      if (parsed.value.action === "ready")
        return Response.json({ status: "ready" }, { headers });
      if (agent.disabledBuiltinTools.includes(parsed.value.toolName)) {
        return Response.json({ status: "deny" }, { headers });
      }
      // The revision grants the full frozen native tool set; package, provider,
      // credential and session revocations were checked immediately above.
      return Response.json({ status: "allow" }, { headers });
    } catch {
      return Response.json({ status: "deny" }, { status: 403, headers });
    }
  });
}
