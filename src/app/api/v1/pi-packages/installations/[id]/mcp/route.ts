import { handlePiPackageMcp } from "@/lib/pi-packages/gateway";
import { piInstallationErrorResponse } from "@/lib/pi-packages/http";
import { withRequestLogging } from "@/lib/observability/http";
export const runtime = "nodejs";
export const maxDuration = 60;
export const POST = withRequestLogging(
  "/api/v1/pi-packages/installations/[id]/mcp",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ id: string }> },
  ) {
    try {
      return await handlePiPackageMcp(req, (await params).id);
    } catch (error) {
      return piInstallationErrorResponse(error);
    }
  },
);
export async function GET() {
  return new Response(null, {
    status: 405,
    headers: { Allow: "POST", "cache-control": "no-store" },
  });
}
