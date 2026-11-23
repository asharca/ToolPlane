import { z } from "zod";
import { withRequestLogging } from "@/lib/observability/http";
import {
  updatePlugin,
  removePlugin,
  pluginMcpBindingsSchema,
} from "@/lib/plugins/installs";
import {
  pluginAddEnvConfigSchema,
  pluginEnvUpdateSchema,
  updatePluginEnvConfig,
} from "@/lib/plugins/env-store";
import {
  pluginApiError,
  pluginJson,
  pluginRequestContext,
} from "../../_shared";
export const runtime = "nodejs";
type Context = { params: Promise<{ slug: string; installId: string }> };
const updateBody = z
  .object({
    targetReleaseId: z.string().min(1).max(240).optional(),
    mcpBindings: pluginMcpBindingsSchema.optional(),
    envConfig: z
      .union([pluginEnvUpdateSchema, pluginAddEnvConfigSchema])
      .optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.targetReleaseId !== undefined || body.envConfig !== undefined,
  );
export const PATCH = withRequestLogging(
  "/api/v1/workspaces/[slug]/plugins/installs/[installId]",
  async (req: Request, { params }: Context) => {
    try {
      const { slug, installId } = await params;
      const { workspace } = await pluginRequestContext(req, slug, "plugins");
      const body = await pluginJson(req, updateBody);
      if (body.targetReleaseId !== undefined) {
        const envConfig = body.envConfig
          ? pluginAddEnvConfigSchema.parse({
              mode: body.envConfig.mode,
              values: body.envConfig.values,
            })
          : undefined;
        return Response.json(
          await updatePlugin(
            workspace,
            installId,
            body.targetReleaseId,
            body.mcpBindings,
            envConfig,
          ),
        );
      }
      const envUpdate = pluginEnvUpdateSchema.parse(body.envConfig);
      return Response.json(
        await updatePluginEnvConfig(workspace, installId, envUpdate),
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
      const { workspace } = await pluginRequestContext(req, slug, "plugins");
      return Response.json(await removePlugin(workspace, installId));
    } catch (error) {
      return pluginApiError(error);
    }
  },
);
