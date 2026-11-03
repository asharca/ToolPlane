import { z } from "zod";
import { withRequestLogging } from "@/lib/observability/http";
import { updatePluginSource, deletePluginSource } from "@/lib/plugins/sources";
import {
  pluginApiError,
  pluginJson,
  pluginRequestContext,
} from "../../_shared";
export const runtime = "nodejs";
type Context = { params: Promise<{ slug: string; sourceId: string }> };
const sourceBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    token: z.string().max(4000).optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.token !== undefined);
export const PATCH = withRequestLogging(
  "/api/v1/workspaces/[slug]/plugins/sources/[sourceId]",
  async (req: Request, { params }: Context) => {
    try {
      const { slug, sourceId } = await params;
      const { user, workspace } = await pluginRequestContext(req, slug);
      return Response.json(
        await updatePluginSource(
          workspace.id,
          user.id,
          sourceId,
          await pluginJson(req, sourceBody),
        ),
      );
    } catch (error) {
      return pluginApiError(error);
    }
  },
);
export const DELETE = withRequestLogging(
  "/api/v1/workspaces/[slug]/plugins/sources/[sourceId]",
  async (req: Request, { params }: Context) => {
    try {
      const { slug, sourceId } = await params;
      const { user, workspace } = await pluginRequestContext(req, slug);
      await deletePluginSource(workspace.id, user.id, sourceId);
      return Response.json({ id: sourceId });
    } catch (error) {
      return pluginApiError(error);
    }
  },
);
