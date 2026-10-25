import { redirect } from "next/navigation";

export default async function LegacyPackageManagementPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const [{ workspace }, query] = await Promise.all([params, searchParams]);
  const suffix = query.q ? `?${new URLSearchParams({ q: query.q })}` : "";
  redirect(`/app/${encodeURIComponent(workspace)}/market/compose${suffix}`);
}
