import { resolveRequestUser } from "@/lib/auth/request-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { getProvider } from "@/lib/agents/queries";
import { withRequestLogging } from "@/lib/observability/http";
import {
  hermesAgentsUsingProvider,
  refreshProviderModels,
  revalidateProviderViews,
  syncHermesAgents,
} from "@/lib/agents/provider-model-refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/providers/[providerId]/models",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ slug: string; providerId: string }> },
  ) {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { slug, providerId } = await params;
    const workspace = await getWorkspaceForUser(slug, user.id);
    if (!workspace)
      return Response.json({ error: "Workspace not found" }, { status: 404 });
    if (workspace.ownerId !== user.id)
      return Response.json({ error: "Not authorized." }, { status: 403 });
    const provider = await getProvider(workspace.id, providerId);
    if (!provider)
      return Response.json({ error: "Provider not found" }, { status: 404 });
    try {
      const agents = await hermesAgentsUsingProvider(workspace.id, providerId);
      const error = await refreshProviderModels(
        workspace.id,
        providerId,
        provider,
      );
      if (error) return Response.json({ error }, { status: 502 });
      const warning = await syncHermesAgents(workspace.id, agents);
      revalidateProviderViews(slug);
      return Response.json({
        savedAt: Date.now(),
        ...(warning ? { warning } : {}),
      });
    } catch {
      return Response.json(
        { error: "Could not refresh provider models." },
        { status: 502 },
      );
    }
  },
);
