import { resolveWorkspaceScope } from "@/lib/workspace/scope";
import { NextResponse } from "next/server";
import { resolveRequestUser } from "@/lib/auth/request-user";

import { getAgentPageData } from "@/lib/agents/queries";
import { buildAgentPluginOptions } from "@/lib/plugins/agent-options";
import { listPlugins, PluginError } from "@/lib/plugins/catalog";
import { withRequestLogging } from "@/lib/observability/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRequestLogging(
  "/api/v1/workspaces/[slug]/agents/[agentId]/plugins/options",
  async function GET(
    req: Request,
    { params }: { params: Promise<{ slug: string; agentId: string }> },
  ) {
    const user = await resolveRequestUser(req);
    if (!user)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const { slug, agentId } = await params;
    const workspace = await resolveWorkspaceScope({ slug }, user.id);
    if (!workspace)
      return NextResponse.json(
        { error: "workspace not found" },
        { status: 404 },
      );

    const agent = await getAgentPageData(workspace.id, agentId);
    if (!agent)
      return NextResponse.json({ error: "agent not found" }, { status: 404 });

    try {
      if (!workspace.permissions.includes("plugins"))
        throw new PluginError(
          "not_authorized",
          "Workspace access denied.",
          403,
        );
      const installs = await listPlugins(workspace, {
        installedOnly: true,
      });
      return NextResponse.json(
        { plugins: buildAgentPluginOptions(installs.items, agent) },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    } catch (error) {
      if (error instanceof PluginError)
        return NextResponse.json(
          { error: error.code },
          { status: error.status },
        );
      throw error;
    }
  },
);
