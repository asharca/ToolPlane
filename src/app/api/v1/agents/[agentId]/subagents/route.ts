import { withRequestLogging } from "@/lib/observability/http";
import { z } from "zod";
import { db } from "@/lib/db";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { isSameOriginRequest } from "@/lib/http/origin";
import {
  listPlatformSubagents,
  savePlatformSubagents,
  SubagentSettingsSchema,
} from "@/lib/agents/platform-subagents";
import {
  pluginApiError,
  pluginJson,
} from "@/app/api/v1/workspaces/[slug]/plugins/_shared";
const input = SubagentSettingsSchema.extend({
  workspace: z.string().min(1).max(240),
}).strict();
export const runtime = "nodejs";
async function handle(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (
      req.method !== "GET" &&
      !req.headers.has("authorization") &&
      !isSameOriginRequest(req)
    )
      return Response.json({ error: "Forbidden" }, { status: 403 });
    const value = req.method === "GET" ? null : await pluginJson(req, input);
    const workspace = await getWorkspaceForUser(
      value?.workspace ?? new URL(req.url).searchParams.get("workspace") ?? "",
      user.id,
    );
    const { agentId } = await params;
    if (
      !workspace ||
      !(await db.agent.findFirst({
        where: { id: agentId, workspaceId: workspace.id },
      }))
    )
      return Response.json({ error: "notFound" }, { status: 404 });
    const result = value
      ? await savePlatformSubagents(workspace.id, user.id, agentId, {
          native: value.native,
          agentIds: value.agentIds,
          nativePolicy: value.nativePolicy,
        })
      : await listPlatformSubagents(workspace.id, user.id, agentId);
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return pluginApiError(error);
  }
}
export const GET = withRequestLogging(
  "/api/v1/agents/[agentId]/subagents",
  handle,
);
export const PUT = withRequestLogging(
  "/api/v1/agents/[agentId]/subagents",
  handle,
);
