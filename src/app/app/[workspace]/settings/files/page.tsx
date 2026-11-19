import { WorkspaceSettingsContent } from "@/components/dashboard/WorkspaceSettingsContent";

export const dynamic = "force-dynamic";

export default async function SettingsFilesPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return <WorkspaceSettingsContent slug={workspace} section="files" />;
}
