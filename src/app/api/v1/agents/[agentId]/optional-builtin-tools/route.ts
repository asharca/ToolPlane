import { z } from "zod";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { isSameOriginRequest } from "@/lib/http/origin";
import { parseJson } from "@/lib/agents/public-api/body";
import { OptionalBuiltinToolsSchema } from "@/lib/agents/revision-types";
import { getAgentOptionalBuiltinTools } from "@/lib/agents/queries";
import {
  AgentConfigurationError,
  updateAgentOptionalBuiltinTools,
} from "@/lib/agents/mutations";
import { AgentExecutionBusyError } from "@/lib/agents/agent-execution-gate";
import { withRequestLogging } from "@/lib/observability/http";

export const runtime = "nodejs";
const input = z
  .object({
    workspace: z.string().min(1).max(240),
    optionalBuiltinTools: OptionalBuiltinToolsSchema,
  })
  .strict();

async function handle(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const headers = { "Cache-Control": "private, no-store" };
  const user = await resolveRequestUser(req);
  if (!user)
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  if (
    req.method !== "GET" &&
    !req.headers.has("authorization") &&
    !isSameOriginRequest(req)
  )
    return Response.json({ error: "Forbidden" }, { status: 403, headers });
  const parsed =
    req.method === "GET" ? null : await parseJson(req, input, 16_000);
  if (parsed && !parsed.ok)
    return Response.json(
      { error: "OPTIONAL_BUILTIN_TOOLS_INVALID" },
      {
        status: parsed.reason === "too_large" ? 413 : 400,
        headers,
      },
    );
  const value = parsed?.ok ? parsed.value : null;
  const workspace = await getWorkspaceForUser(
    value?.workspace ?? new URL(req.url).searchParams.get("workspace") ?? "",
    user.id,
  );
  if (!workspace)
    return Response.json({ error: "notFound" }, { status: 404, headers });
  const { agentId } = await params;
  try {
    const current = await getAgentOptionalBuiltinTools(workspace.id, agentId);
    if (!current)
      return Response.json({ error: "notFound" }, { status: 404, headers });
    if (!value) return Response.json(current, { headers });
    if (current.readOnly)
      return Response.json(
        { error: "AGENT_EXECUTION_RETIRED" },
        { status: 410, headers },
      );
    const saved = await updateAgentOptionalBuiltinTools(
      workspace.id,
      agentId,
      value.optionalBuiltinTools,
    );
    if (!saved)
      return Response.json({ error: "notFound" }, { status: 404, headers });
    return Response.json(
      await getAgentOptionalBuiltinTools(workspace.id, agentId),
      { headers },
    );
  } catch (error) {
    if (error instanceof AgentExecutionBusyError)
      return Response.json({ error: "agentBusy" }, { status: 409, headers });
    if (error instanceof AgentConfigurationError)
      return Response.json(
        { error: "OPTIONAL_BUILTIN_TOOLS_INVALID" },
        { status: 400, headers },
      );
    return Response.json(
      { error: "OPTIONAL_BUILTIN_TOOLS_SAVE_FAILED" },
      { status: 500, headers },
    );
  }
}

export const GET = withRequestLogging(
  "/api/v1/agents/[agentId]/optional-builtin-tools",
  handle,
);
export const PUT = withRequestLogging(
  "/api/v1/agents/[agentId]/optional-builtin-tools",
  handle,
);
