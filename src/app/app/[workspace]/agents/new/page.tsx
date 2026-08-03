import { redirect } from 'next/navigation';

// Retain the previous browse URL for bookmarks while keeping market navigation
// entirely within the authenticated workspace console.
export default async function LegacyBrowseAgentsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  redirect(`/app/${encodeURIComponent(workspace)}/market/agents`);
}
