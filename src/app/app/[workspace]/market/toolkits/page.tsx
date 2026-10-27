import { redirect } from "next/navigation";

export default async function ToolkitMarketPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  redirect(`/app/${encodeURIComponent(workspace)}/market?type=pi-package`);
}
