import { withRequestLogging } from "@/lib/observability/http";
import { resolveAccountRequestUser } from "@/lib/auth/request-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { getPiPackageDownload } from "@/lib/market/pi-package-archive";

export const runtime = "nodejs";

export const GET = withRequestLogging(
  "/api/v1/workspaces/[slug]/market/pi-packages/[releaseId]/download",
  async function GET(
    req: Request,
    { params }: { params: Promise<{ slug: string; releaseId: string }> },
  ) {
    const { slug, releaseId } = await params;
    const user = await resolveAccountRequestUser(req);
    if (!user)
      return Response.json({ code: "not_authorized" }, { status: 401 });
    const workspace = await getWorkspaceForUser(slug, user.id);
    if (!workspace)
      return Response.json({ code: "not_authorized" }, { status: 403 });
    try {
      const artifact = await getPiPackageDownload({
        workspaceId: workspace.id,
        userId: user.id,
        releaseId,
      });
      return new Response(new Uint8Array(artifact.archive), {
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": `attachment; filename="${artifact.filename}"`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Toolplane-Release-Checksum": artifact.checksum,
        },
      });
    } catch (error) {
      const code =
        error instanceof Error &&
        ["not_authorized", "listing_unavailable"].includes(error.message)
          ? error.message
          : "pi_package_invalid";
      return Response.json(
        { code },
        {
          status:
            code === "not_authorized"
              ? 403
              : code === "listing_unavailable"
                ? 404
                : 422,
        },
      );
    }
  },
);
