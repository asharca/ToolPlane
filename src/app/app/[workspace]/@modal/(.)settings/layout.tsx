import { WorkspaceSettingsDialog } from '@/components/dashboard/WorkspaceSettingsDialog';

export default async function InterceptedSettingsLayout({ children, params }: { children: React.ReactNode; params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  return <WorkspaceSettingsDialog slug={workspace}>{children}</WorkspaceSettingsDialog>;
}
