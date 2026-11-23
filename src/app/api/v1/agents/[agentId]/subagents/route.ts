import { resolveWorkspaceScope } from "@/lib/workspace/scope";
import { withRequestLogging } from "@/lib/observability/http";
import { z } from "zod";
import { db } from "@/lib/db";
import { resolveRequestUser } from "@/lib/auth/request-user";

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
    const value = req.method === "GET" ? null : await pluginJson(req, input);
    const workspace = await resolveWorkspaceScope(
      {
        slug:
          value?.workspace ??
          new URL(req.url).searchParams.get("workspace") ??
          "",
      },
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
    const manageScope = value
      ? await resolveWorkspaceScope({ id: workspace.id }, user.id, "agents")
      : null;
    if (value && !manageScope)
      return Response.json(
        { error: "Workspace access denied.", code: "not_authorized" },
        { status: 403 },
      );
    const result =
      value && manageScope
        ? await savePlatformSubagents(manageScope, agentId, {
            native: value.native,
            agentIds: value.agentIds,
            nativePolicy: value.nativePolicy,
          })
        : await listPlatformSubagents(workspace, agentId);
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
