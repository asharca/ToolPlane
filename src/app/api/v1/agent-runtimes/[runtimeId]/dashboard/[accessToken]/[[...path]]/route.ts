import { withRequestLogging } from "@/lib/observability/http";

export const runtime = "nodejs";
export const GET = withRequestLogging(
  "/api/v1/agent-runtimes/[runtimeId]/dashboard/[accessToken]/[[...path]]",
  async () =>
    Response.json(
      {
        error:
          "Legacy Agent dashboards are retired. Historical files remain available through the read-only session workspace.",
      },
      { status: 410 },
    ),
);
export const HEAD = GET;
export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const OPTIONS = GET;
