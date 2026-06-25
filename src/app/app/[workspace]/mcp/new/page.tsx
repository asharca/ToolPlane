import Link from 'next/link';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getDeployments } from '@/lib/workspace/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { BrowseGrid } from '@/components/dashboard/BrowseGrid';
import { deployServerAction } from '@/lib/workspace/actions';

export const dynamic = 'force-dynamic';

export default async function BrowseMcpPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const [servers, deployed] = await Promise.all([
    db.server.findMany({
      orderBy: { stars: 'desc' },
      take: 24,
      select: { id: true, name: true, description: true, iconUrl: true },
    }),
    getDeployments(ws.id),
  ]);
  const deployedIds = new Set(deployed.map((d) => d.serverId));

  return (
    <>
      <DashboardHeader
        title="Browse MCPs"
        actions={
          <Link
            href={`/app/${slug}/mcp`}
            className="text-sm text-zinc-500 transition-colors hover:text-zinc-900"
          >
            ← Back to servers
          </Link>
        }
      />
      <div className="px-8 py-6">
        <BrowseGrid
          items={servers}
          installedIds={deployedIds}
          slug={slug}
          action={deployServerAction}
          idField="serverId"
          actionLabel="Deploy"
          installedLabel="Deployed"
        />
      </div>
    </>
  );
}
