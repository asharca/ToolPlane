import { z } from "zod";
import { withRequestLogging } from "@/lib/observability/http";
import { listPluginSources, createPluginSource } from "@/lib/plugins/sources";
import { pluginApiError, pluginJson, pluginRequestContext } from "../_shared";
export const runtime = "nodejs";
type Context = { params: Promise<{ slug: string }> };
const sourceBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    repository: z.string().trim().min(1).max(240),
    branch: z.string().trim().min(1).max(240).optional(),
    visibility: z.enum(["public", "private"]).optional(),
    token: z.string().max(4000).optional(),
  })
  .strict();
export const GET = withRequestLogging(
  "/api/v1/workspaces/[slug]/plugins/sources",
  async (req: Request, { params }: Context) => {
    try {
      const { slug } = await params;
      const { user, workspace } = await pluginRequestContext(req, slug);
      return Response.json({
        items: await listPluginSources(workspace.id, user.id),
      });
    } catch (error) {
      return pluginApiError(error);
    }
  },
);
export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/plugins/sources",
  async (req: Request, { params }: Context) => {
    try {
      const { slug } = await params;
      const { user, workspace } = await pluginRequestContext(req, slug);
      return Response.json(
        await createPluginSource(
          workspace.id,
          user.id,
          await pluginJson(req, sourceBody),
        ),
        { status: 201 },
      );
    } catch (error) {
      return pluginApiError(error);
    }
  },
);
