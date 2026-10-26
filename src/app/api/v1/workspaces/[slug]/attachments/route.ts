import { withRequestLogging } from "@/lib/observability/http";

export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/attachments",
  async function POST() {
    return Response.json(
      {
        error:
          "Workspace file uploads are disabled. Import files from a GitHub repository or a packaged ZIP instead.",
      },
      { status: 403 },
    );
  },
);
