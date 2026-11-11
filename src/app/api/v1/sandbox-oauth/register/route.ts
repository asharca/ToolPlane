import { withRequestLogging } from "@/lib/observability/http";
import { handleSandboxOAuth } from "@/lib/sandboxes/oauth-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = withRequestLogging(
  "/api/v1/sandbox-oauth/register",
  function POST(req: Request) {
    return handleSandboxOAuth(req, "register");
  },
);
