import { withRequestLogging } from "@/lib/observability/http";
import { getPlugin } from "@/lib/plugins/catalog";
import { pluginApiError, pluginRequestContext } from "../_shared";
export const runtime = "nodejs";
export const GET = withRequestLogging(
  "/api/v1/workspaces/[slug]/plugins/[listingId]",
  async (
    req: Request,
    { params }: { params: Promise<{ slug: string; listingId: string }> },
  ) => {
    try {
      const { slug, listingId } = await params;
      const { user, workspace } = await pluginRequestContext(req, slug);
      return Response.json(await getPlugin(workspace.id, user.id, listingId));
    } catch (error) {
      return pluginApiError(error);
    }
  },
);
