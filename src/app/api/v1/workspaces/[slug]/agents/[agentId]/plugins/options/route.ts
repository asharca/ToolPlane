import { NextResponse } from "next/server";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { getAgentPageData } from "@/lib/agents/queries";
import { buildAgentPluginOptions } from "@/lib/plugins/agent-options";
import {
  listPlugins,
  PluginError,
  requirePluginWorkspace,
} from "@/lib/plugins/catalog";
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
    const workspace = await getWorkspaceForUser(slug, user.id);
    if (!workspace)
      return NextResponse.json(
        { error: "workspace not found" },
        { status: 404 },
      );

    const agent = await getAgentPageData(workspace.id, agentId);
    if (!agent)
      return NextResponse.json({ error: "agent not found" }, { status: 404 });

    try {
      // Match plugin editing authority without changing the page's read policy.
      await requirePluginWorkspace(workspace.id, user.id, true);
      const installs = await listPlugins(workspace.id, user.id, {
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
