import { accountConnectionApi } from "@/lib/account-connections/http";
import { withRequestLogging } from "@/lib/observability/http";

async function handle(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  return accountConnectionApi(req, slug);
}

export const GET = withRequestLogging(
  "/api/v1/workspaces/[slug]/account-connections",
  handle,
);
export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/account-connections",
  handle,
);
