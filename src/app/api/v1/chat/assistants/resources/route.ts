import { resolveWorkspaceScope } from "@/lib/workspace/scope";
import { resolveAccountRequestUser } from "@/lib/auth/request-user";
import { withRequestLogging } from "@/lib/observability/http";
import { listChatDeploymentOptions } from "@/lib/chat/resources";
import { ChatServiceError } from "@/lib/chat/shared";

export const runtime = "nodejs";
export const GET = withRequestLogging(
  "/api/v1/chat/assistants/resources",
  async (req: Request) => {
    const user = await resolveAccountRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspaceId = new URL(req.url).searchParams.get("workspaceId");
    if (!workspaceId)
      return Response.json(
        { error: "A workspace ID is required" },
        { status: 400 },
      );
    try {
      const scope = await resolveWorkspaceScope({ id: workspaceId }, user.id);
      if (!scope) throw new ChatServiceError(404, "Workspace not found");
      return Response.json(
        { deployments: await listChatDeploymentOptions(scope) },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    } catch (error) {
      return error instanceof ChatServiceError
        ? Response.json({ error: error.message }, { status: error.status })
        : Response.json(
            { error: "Assistant resources are unavailable" },
            { status: 500 },
          );
    }
  },
);
