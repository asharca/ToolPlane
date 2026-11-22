import { accountConnectionApi } from "@/lib/account-connections/http";
import { withRequestLogging } from "@/lib/observability/http";

async function handle(
  req: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  return accountConnectionApi(req, slug, id, "start");
}

export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/account-connections/[id]/oauth/start",
  handle,
);
