import { redirect } from "next/navigation";

export default async function LegacyResourceSourcesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ source?: string; q?: string; page?: string }>;
}) {
  const [{ workspace }, query] = await Promise.all([params, searchParams]);
  const next = new URLSearchParams();
  if (query.source) next.set("source", query.source);
  if (query.q) next.set("q", query.q);
  if (query.page) next.set("page", query.page);
  const suffix = next.size ? `?${next}` : "";
  redirect(`/app/${encodeURIComponent(workspace)}/market/sources${suffix}`);
}
