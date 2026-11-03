import { z } from "zod";
import { withRequestLogging } from "@/lib/observability/http";
import { listPlugins } from "@/lib/plugins/catalog";
import { addPlugin, pluginMcpBindingsSchema } from "@/lib/plugins/installs";
import { pluginApiError, pluginJson, pluginRequestContext } from "./_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ slug: string }> };
const addBody = z
  .object({
    listingId: z.string().min(1).max(240),
    mcpBindings: pluginMcpBindingsSchema.optional(),
  })
  .strict();

export const GET = withRequestLogging(
  "/api/v1/workspaces/[slug]/plugins",
  async (req: Request, { params }: Context) => {
    try {
      const { slug } = await params;
      const { user, workspace } = await pluginRequestContext(req, slug);
      const search = new URL(req.url).searchParams;
      return Response.json(
        await listPlugins(workspace.id, user.id, {
          sourceId: search.get("sourceId") ?? undefined,
          query: search.get("query") ?? undefined,
          installedOnly: search.get("installed") === "true",
        }),
      );
    } catch (error) {
      return pluginApiError(error);
    }
  },
);

export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/plugins",
  async (req: Request, { params }: Context) => {
    try {
      const { slug } = await params;
      const { user, workspace } = await pluginRequestContext(req, slug);
      const body = await pluginJson(req, addBody);
      return Response.json(
        await addPlugin(
          workspace.id,
          user.id,
          body.listingId,
          body.mcpBindings,
        ),
        { status: 201 },
      );
    } catch (error) {
      return pluginApiError(error);
    }
  },
);
