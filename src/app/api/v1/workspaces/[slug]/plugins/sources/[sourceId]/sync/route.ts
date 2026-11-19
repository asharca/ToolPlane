import { withRequestLogging } from "@/lib/observability/http";
import { syncPluginSource } from "@/lib/plugins/sources";
import { pluginApiError, pluginRequestContext } from "../../../_shared";
export const runtime = "nodejs";
export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/plugins/sources/[sourceId]/sync",
  async (
    req: Request,
    { params }: { params: Promise<{ slug: string; sourceId: string }> },
  ) => {
    try {
      const { slug, sourceId } = await params;
      const { workspace } = await pluginRequestContext(req, slug, "read");
      return Response.json(await syncPluginSource(workspace, sourceId), {
        status: 202,
      });
    } catch (error) {
      return pluginApiError(error);
    }
  },
);
