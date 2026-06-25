import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import {
  getWorkspaceForUser,
  listWorkspacesForUser,
} from '@/lib/workspace/queries';
import { DashboardChrome } from '@/components/dashboard/DashboardChrome';

export const dynamic = 'force-dynamic';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/mcp`)}`);
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const workspaces = await listWorkspacesForUser(user.id);

  return (
    <DashboardChrome
      slug={ws.slug}
      workspaceName={ws.name}
      userLabel={user.name ?? user.email}
      workspaces={workspaces}
    >
      {children}
    </DashboardChrome>
  );
}
