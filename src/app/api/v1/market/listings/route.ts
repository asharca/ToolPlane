import { withRequestLogging } from "@/lib/observability/http";
import { listMarketListings } from "@/lib/market/listings";

export const runtime = "nodejs";

export const GET = withRequestLogging(
  "/api/v1/market/listings",
  async function GET(req: Request) {
    const query = new URL(req.url).searchParams;
    const requestedSort = query.get("sort");
    const requestedRuntime = query.get("runtime");
    const result = await listMarketListings({
      kind: query.get("kind") ?? undefined,
      q: query.get("q") ?? undefined,
      tag: query.get("tag") ?? undefined,
      category: query.get("category") ?? undefined,
      sourceKind: query.get("sourceKind") ?? undefined,
      runtime:
        requestedRuntime === "pi-sdk" || requestedRuntime === "mcp"
          ? requestedRuntime
          : undefined,
      sort:
        requestedSort === "newest" || requestedSort === "name"
          ? requestedSort
          : "popular",
      page: Number(query.get("page")),
      pageSize: Number(query.get("pageSize")),
    });
    return Response.json(result);
  },
);
