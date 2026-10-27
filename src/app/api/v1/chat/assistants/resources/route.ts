import { resolveAccountRequestUser } from "@/lib/auth/request-user";
import { withRequestLogging } from "@/lib/observability/http";
import { listChatDeploymentOptions } from "@/lib/chat/resources";
import { ChatServiceError } from "@/lib/chat/service";

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
      return Response.json(
        { deployments: await listChatDeploymentOptions(user.id, workspaceId) },
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
