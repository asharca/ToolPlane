import { redirect } from "next/navigation";

export default async function NewMcpPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  redirect(`/app/${encodeURIComponent(workspace)}/mcp?create=1`);
}
