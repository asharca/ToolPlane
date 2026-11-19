import { withRequestLogging } from "@/lib/observability/http";
import { PrivatePluginInputSchema } from "@/lib/agents/capability-contracts";
import { createPrivatePlugin } from "@/lib/plugins/local";
import { parseJson } from "@/lib/agents/public-api/body";
import { pluginApiError, pluginRequestContext } from "../_shared";
export const runtime = "nodejs";
export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/plugins/local",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ slug: string }> },
  ) {
    try {
      const { workspace } = await pluginRequestContext(
        req,
        (await params).slug,
        "manage",
      );
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
      return Response.json(await createPrivatePlugin(workspace, input.value));
    } catch (error) {
      return pluginApiError(error);
    }
  },
);
