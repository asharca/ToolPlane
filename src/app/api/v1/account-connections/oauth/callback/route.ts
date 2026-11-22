import { resolveRequestPrincipal } from "@/lib/auth/request-user";
import { withRequestLogging } from "@/lib/observability/http";
import { finishOAuth } from "@/lib/account-connections/oauth";

export const GET = withRequestLogging(
  "/api/v1/account-connections/oauth/callback",
  async (req: Request) => {
    const principal = await resolveRequestPrincipal(req);
    return finishOAuth(
      principal?.credential === "session" ? principal.user.id : null,
      new URL(req.url).searchParams,
    );
  },
);
