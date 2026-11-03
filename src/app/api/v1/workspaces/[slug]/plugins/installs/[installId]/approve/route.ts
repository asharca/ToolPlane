import { z } from "zod";
import { withRequestLogging } from "@/lib/observability/http";
import { approveAgentPluginSync } from "@/lib/plugins/agent-sync";
import {
  pluginApiError,
  pluginJson,
  pluginRequestContext,
} from "../../../_shared";
export const runtime = "nodejs";
const bodySchema = z
  .object({
    agentId: z.string().min(1).max(240),
    targetReleaseId: z.string().min(1).max(240),
  })
  .strict();
export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/plugins/installs/[installId]/approve",
  async (
    req: Request,
    { params }: { params: Promise<{ slug: string; installId: string }> },
  ) => {
    try {
      const { slug, installId } = await params;
      const { user, workspace } = await pluginRequestContext(req, slug);
      const { agentId, targetReleaseId } = await pluginJson(req, bodySchema);
      return Response.json(
        await approveAgentPluginSync(
          workspace.id,
          user.id,
          agentId,
          installId,
          targetReleaseId,
        ),
      );
    } catch (error) {
      return pluginApiError(error);
    }
  },
);
