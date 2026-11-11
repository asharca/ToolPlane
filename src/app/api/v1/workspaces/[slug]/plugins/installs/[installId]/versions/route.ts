import { withRequestLogging } from "@/lib/observability/http";
import { PrivatePluginInputSchema } from "@/lib/agents/capability-contracts";
import { appendPrivatePluginVersion } from "@/lib/plugins/local";
import { isSameOriginRequest } from "@/lib/http/origin";
import { parseJson } from "@/lib/agents/public-api/body";
import { pluginApiError, pluginRequestContext } from "../../../_shared";
export const runtime = "nodejs";
export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/plugins/installs/[installId]/versions",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ slug: string; installId: string }> },
  ) {
    try {
      const { slug, installId } = await params;
      const { workspace, user } = await pluginRequestContext(req, slug);
      if (!req.headers.has("authorization") && !isSameOriginRequest(req))
        return Response.json({ error: "Forbidden" }, { status: 403 });
      const input = await parseJson(
        req,
        PrivatePluginInputSchema,
        96 * 1024 * 1024,
      );
      if (!input.ok)
        return Response.json(
          { error: "PLUGIN_INVALID" },
          { status: input.reason === "too_large" ? 413 : 400 },
        );
      return Response.json(
        await appendPrivatePluginVersion(
          workspace.id,
          user.id,
          installId,
          input.value,
        ),
      );
    } catch (error) {
      return pluginApiError(error);
    }
  },
);
