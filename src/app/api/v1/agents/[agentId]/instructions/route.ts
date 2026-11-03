import { z } from "zod";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { isSameOriginRequest } from "@/lib/http/origin";
import { parseJson } from "@/lib/agents/public-api/body";
import {
  OMP_CONFIG_MAX_BYTES,
  OmpInstructionFilesSchema,
} from "@/lib/agents/omp-config";
import {
  OmpConfigError,
  readOmpInstructions,
  saveOmpInstructionsDraft,
} from "@/lib/agents/omp-config-server";
import { AgentExecutionBusyError } from "@/lib/agents/agent-execution-gate";
import { PluginError } from "@/lib/plugins/catalog";
import { withRequestLogging } from "@/lib/observability/http";
export const runtime = "nodejs";
const input = z
  .object({
    workspace: z.string().min(1).max(240),
    files: OmpInstructionFilesSchema,
  })
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
    req.method === "GET"
      ? null
      : await parseJson(req, input, OMP_CONFIG_MAX_BYTES + 1024);
  if (parsed && !parsed.ok)
    return Response.json(
      { error: "OMP_INSTRUCTIONS_INVALID" },
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
    const result = value
      ? await saveOmpInstructionsDraft({
          workspaceId: workspace.id,
          userId: user.id,
          agentId,
          files: value.files,
        })
      : await readOmpInstructions(workspace.id, user.id, agentId);
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof OmpConfigError || error instanceof PluginError)
      return Response.json({ error: error.code }, { status: error.status });
    if (error instanceof AgentExecutionBusyError)
      return Response.json({ error: "agentBusy" }, { status: 409 });
    return Response.json(
      { error: "OMP_INSTRUCTIONS_SAVE_FAILED" },
      { status: 500 },
    );
  }
}
export const GET = withRequestLogging(
  "/api/v1/agents/[agentId]/instructions",
  handle,
);
export const PUT = withRequestLogging(
  "/api/v1/agents/[agentId]/instructions",
  handle,
);
