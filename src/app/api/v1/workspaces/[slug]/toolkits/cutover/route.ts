import { z } from "zod";
import { withRequestLogging } from "@/lib/observability/http";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import {
  privateJson,
  readSandboxJson,
  RequestBodyError,
} from "@/lib/sandboxes/http-body";
import { PluginError } from "@/lib/plugins/catalog";
import { cutoverToolkitToPrivatePackage } from "@/lib/toolkits/cutover";

export const runtime = "nodejs";
const inputSchema = z.discriminatedUnion("mode", [
  z
    .object({
      toolkitId: z.string().min(1).max(128),
      mode: z.literal("dry-run"),
    })
    .strict(),
  z
    .object({
      toolkitId: z.string().min(1).max(128),
      mode: z.literal("apply"),
      expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
      confirmReauthorization: z.literal(true),
    })
    .strict(),
]);

export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/toolkits/cutover",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ slug: string }> },
  ) {
    try {
      const user = await resolveRequestUser(req);
      if (!user) return privateJson({ error: "Unauthorized" }, 401);
      const workspace = await getWorkspaceForUser((await params).slug, user.id);
      if (!workspace) return privateJson({ error: "Workspace not found" }, 404);
      const context = { workspaceId: workspace.id, userId: user.id };
      const input = inputSchema.parse(await readSandboxJson(req));
      return privateJson(
        await cutoverToolkitToPrivatePackage({ ...context, ...input }),
      );
    } catch (error) {
      if (error instanceof PluginError)
        return privateJson(
          { error: error.code },
          error.code === "not_authorized"
            ? 403
            : error.code === "source_changed" || error.code === "in_use"
              ? 409
              : 400,
        );
      if (error instanceof RequestBodyError)
        return privateJson({ error: error.message }, error.status);
      if (error instanceof z.ZodError)
        return privateJson({ error: "Invalid request body" }, 400);
      throw error;
    }
  },
);
