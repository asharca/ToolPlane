import { z } from "zod";
import { withRequestLogging } from "@/lib/observability/http";
import {
  updatePlugin,
  removePlugin,
  pluginMcpBindingsSchema,
} from "@/lib/plugins/installs";
import {
  pluginApiError,
  pluginJson,
  pluginRequestContext,
} from "../../_shared";
export const runtime = "nodejs";
type Context = { params: Promise<{ slug: string; installId: string }> };
const updateBody = z
  .object({
    targetReleaseId: z.string().min(1).max(240),
    mcpBindings: pluginMcpBindingsSchema.optional(),
  })
  .strict();
export const PATCH = withRequestLogging(
  "/api/v1/workspaces/[slug]/plugins/installs/[installId]",
  async (req: Request, { params }: Context) => {
    try {
      const { slug, installId } = await params;
      const { user, workspace } = await pluginRequestContext(req, slug);
      const body = await pluginJson(req, updateBody);
      return Response.json(
        await updatePlugin(
          workspace.id,
          user.id,
          installId,
          body.targetReleaseId,
          body.mcpBindings,
        ),
      );
    } catch (error) {
      return pluginApiError(error);
    }
  },
);
export const DELETE = withRequestLogging(
  "/api/v1/workspaces/[slug]/plugins/installs/[installId]",
  async (req: Request, { params }: Context) => {
    try {
      const { slug, installId } = await params;
      const { user, workspace } = await pluginRequestContext(req, slug);
      return Response.json(
        await removePlugin(workspace.id, user.id, installId),
      );
    } catch (error) {
      return pluginApiError(error);
    }
  },
);
