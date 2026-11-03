import { PrivatePluginInputSchema } from "@/lib/agents/capability-contracts";
import { createPrivatePlugin } from "@/lib/plugins/local";
import { isSameOriginRequest } from "@/lib/http/origin";
import { parseJson } from "@/lib/agents/public-api/body";
import { pluginApiError, pluginRequestContext } from "../_shared";
export const runtime = "nodejs";
export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { workspace, user } = await pluginRequestContext(
      req,
      (await params).slug,
    );
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
      await createPrivatePlugin(workspace.id, user.id, input.value),
    );
  } catch (error) {
    return pluginApiError(error);
  }
}
