import { redirect } from "next/navigation";

export default async function RetiredToolkitCreatePage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  redirect(`/app/${encodeURIComponent(workspace)}/market/compose`);
}
