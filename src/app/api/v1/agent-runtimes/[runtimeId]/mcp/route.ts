import { withRequestLogging } from "@/lib/observability/http";

export const runtime = "nodejs";
export const POST = withRequestLogging(
  "/api/v1/agent-runtimes/[runtimeId]/mcp",
  async () =>
    Response.json(
      {
        error:
          "Legacy Agent runtime MCP endpoints are retired. Use a pinned Pi session and its scoped MCP broker.",
      },
      { status: 410 },
    ),
);
export const GET = POST;
