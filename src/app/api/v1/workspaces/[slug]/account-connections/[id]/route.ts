import { accountConnectionApi } from "@/lib/account-connections/http";
import { withRequestLogging } from "@/lib/observability/http";

async function handle(
  req: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  return accountConnectionApi(req, slug, id);
}

export const PATCH = withRequestLogging(
  "/api/v1/workspaces/[slug]/account-connections/[id]",
  handle,
);
export const DELETE = withRequestLogging(
  "/api/v1/workspaces/[slug]/account-connections/[id]",
  handle,
);
