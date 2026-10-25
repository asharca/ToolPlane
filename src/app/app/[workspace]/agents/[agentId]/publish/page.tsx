import { redirect } from "next/navigation";

export default async function AgentPublicationPage({
  params,
}: {
  params: Promise<{ workspace: string; agentId: string }>;
}) {
  const { workspace } = await params;
  redirect(`/app/${encodeURIComponent(workspace)}/market/import?type=pi`);
}
