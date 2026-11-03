import { z } from "zod";
import { pluginInstallConfig } from "@/lib/plugins/local";
import { isSameOriginRequest } from "@/lib/http/origin";
import {
  pluginApiError,
  pluginJson,
  pluginRequestContext,
} from "../../../_shared";
export const runtime = "nodejs";
const input = z
  .object({
    config: z.record(z.string(), z.json()),
    enabledFeatures: z
      .array(z.string().min(1).max(240))
      .max(256)
      .nullable()
      .optional(),
  })
  .strict();
async function handle(
  req: Request,
  { params }: { params: Promise<{ slug: string; installId: string }> },
) {
  try {
    const { slug, installId } = await params;
    const { workspace, user } = await pluginRequestContext(req, slug);
    if (
      req.method === "PATCH" &&
      !req.headers.has("authorization") &&
      !isSameOriginRequest(req)
    )
      return Response.json({ error: "Forbidden" }, { status: 403 });
    const value = req.method === "PATCH" ? await pluginJson(req, input) : null;
    return Response.json(
      await pluginInstallConfig(
        workspace.id,
        user.id,
        installId,
        value?.config,
        value?.enabledFeatures,
      ),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return pluginApiError(error);
  }
}
export const GET = handle;
export const PATCH = handle;
