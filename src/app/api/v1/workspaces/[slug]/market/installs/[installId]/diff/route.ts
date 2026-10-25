import { z } from "zod";
import { withRequestLogging } from "@/lib/observability/http";
import { resolveAccountRequestUser } from "@/lib/auth/request-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { marketErrorResponse } from "@/lib/market/http";
import { getMarketInstallReleaseDiff } from "@/lib/market/install-release-diff";

export const runtime = "nodejs";
const querySchema = z.object({
  targetReleaseId: z.string().min(1).max(240),
  page: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  pageSize: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
});
export const GET = withRequestLogging(
  "/api/v1/workspaces/[slug]/market/installs/[installId]/diff",
  async function GET(
    req: Request,
    { params }: { params: Promise<{ slug: string; installId: string }> },
  ) {
    const { slug, installId } = await params;
    const user = await resolveAccountRequestUser(req);
    const workspace = user ? await getWorkspaceForUser(slug, user.id) : null;
    const headers = { "cache-control": "private, no-store" };
    if (!user || !workspace)
      return Response.json({ error: "Unauthorized" }, { status: 401, headers });
    const parsed = querySchema.safeParse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    if (!parsed.success)
      return Response.json(
        { error: "Invalid release comparison request." },
        { status: 400, headers },
      );
    try {
      const result = await getMarketInstallReleaseDiff({
        workspaceId: workspace.id,
        userId: user.id,
        installId,
        ...parsed.data,
      });
      return Response.json(result, { headers });
    } catch (error) {
      const response = marketErrorResponse(error);
      response.headers.set("cache-control", "private, no-store");
      return response;
    }
  },
);
