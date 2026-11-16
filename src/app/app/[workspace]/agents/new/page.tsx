import { redirect } from "next/navigation";

// The Agent market was removed; Agents are now distributed in plugin packages.
// Keep the old browse URL working for bookmarks.
export default async function LegacyBrowseAgentsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  redirect(`/app/${encodeURIComponent(workspace)}/plugins`);
}
