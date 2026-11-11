import { withRequestLogging } from "@/lib/observability/http";
import { handleSandboxOAuth } from "@/lib/sandboxes/oauth-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withRequestLogging(
  "/api/v1/sandbox-oauth/authorize",
  function GET(req: Request) {
    return handleSandboxOAuth(req, "authorize");
  },
);
export const POST = withRequestLogging(
  "/api/v1/sandbox-oauth/authorize",
  function POST(req: Request) {
    return handleSandboxOAuth(req, "authorize");
  },
);
