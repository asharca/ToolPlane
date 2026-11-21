import { resolveRequestPrincipal } from "@/lib/auth/request-user";
import { withRequestLogging } from "@/lib/observability/http";
import { finishAuthorization } from "@/lib/remote-mcp/oauth/flow";

export const GET = withRequestLogging(
  "/api/v1/mcp-oauth/callback",
  async (req: Request) => {
    const principal = await resolveRequestPrincipal(req);
    if (principal?.credential !== "session")
      return Response.json(
        { error: "oauthDenied" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    const params = new URL(req.url).searchParams;
    return finishAuthorization(principal.user.id, params);
  },
);
