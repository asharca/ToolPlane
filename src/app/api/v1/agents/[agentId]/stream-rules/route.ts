import { z } from "zod";
import { db } from "@/lib/db";
import { ORDINARY_AGENT_FILTER } from "@/lib/agents/queries";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { isSameOriginRequest } from "@/lib/http/origin";
import { parseJson } from "@/lib/agents/public-api/body";
import {
  StreamRulesSchema,
  streamRuleValidationCode,
} from "@/lib/agents/stream-rules";
import {
  AgentExecutionBusyError,
  withAgentDraftLease,
} from "@/lib/agents/agent-execution-gate";
import { withRequestLogging } from "@/lib/observability/http";

export const runtime = "nodejs";
const input = z
  .object({ workspace: z.string().min(1).max(240), streamRules: z.unknown() })
  .strict();
async function handle(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (
    req.method !== "GET" &&
    !req.headers.has("authorization") &&
    !isSameOriginRequest(req)
  )
    return Response.json({ error: "Forbidden" }, { status: 403 });
  const parsed =
    req.method === "GET" ? null : await parseJson(req, input, 1_048_576);
  if (parsed && !parsed.ok)
    return Response.json(
      { error: "STREAM_RULES_INVALID" },
      { status: parsed.reason === "too_large" ? 413 : 400 },
    );
  const value = parsed?.ok ? parsed.value : null;
  const workspace = await getWorkspaceForUser(
    value?.workspace ?? new URL(req.url).searchParams.get("workspace") ?? "",
    user.id,
  );
  if (!workspace) return Response.json({ error: "notFound" }, { status: 404 });
  const { agentId } = await params;
  try {
    const apply = async () => {
      const agent = await db.agent.findFirst({
        where: {
          id: agentId,
          workspaceId: workspace.id,
          ...ORDINARY_AGENT_FILTER,
        },
        select: { runtimeKind: true, retiredAt: true, streamRules: true },
      });
      if (!agent) return Response.json({ error: "notFound" }, { status: 404 });
      if (agent.runtimeKind !== "pi-sdk" || agent.retiredAt)
        return Response.json(
          { error: "AGENT_EXECUTION_RETIRED" },
          { status: 409 },
        );
      if (!value)
        return Response.json(
          { streamRules: agent.streamRules ?? [] },
          { headers: { "Cache-Control": "private, no-store" } },
        );
      const rules = StreamRulesSchema.safeParse(value.streamRules);
      if (!rules.success)
        return Response.json(
          { error: streamRuleValidationCode(rules.error) },
          { status: 400 },
        );
      await db.agent.updateMany({
        where: { id: agentId, workspaceId: workspace.id },
        data: { streamRules: rules.data },
      });
      return Response.json(
        { streamRules: rules.data },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    };
    return value ? await withAgentDraftLease(agentId, apply) : await apply();
  } catch (error) {
    if (error instanceof AgentExecutionBusyError)
      return Response.json({ error: "agentBusy" }, { status: 409 });
    return Response.json(
      { error: "STREAM_RULES_SAVE_FAILED" },
      { status: 500 },
    );
  }
}
export const GET = withRequestLogging(
  "/api/v1/agents/[agentId]/stream-rules",
  handle,
);
export const PUT = withRequestLogging(
  "/api/v1/agents/[agentId]/stream-rules",
  handle,
);
