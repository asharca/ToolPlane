import Link from 'next/link';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getDeployments } from '@/lib/workspace/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { deployServerAction } from '@/lib/workspace/actions';

export const dynamic = 'force-dynamic';

export default async function BrowseMcpPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const [servers, deployed] = await Promise.all([
    db.server.findMany({
      orderBy: { stars: 'desc' },
      take: 24,
      select: { id: true, slug: true, name: true, description: true, iconUrl: true },
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {servers.map((s) => (
            <div
              key={s.id}
              className="flex flex-col rounded-lg border border-zinc-200 p-4"
            >
              <div className="mb-2 flex items-center gap-2.5">
                {s.iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={s.iconUrl}
                    alt=""
                    width={20}
                    height={20}
                    className="size-5 rounded object-cover"
                  />
                ) : (
                  <span className="size-5 rounded bg-zinc-200" />
                )}
                <span className="font-medium text-zinc-900">{s.name}</span>
              </div>
              <p className="mb-4 line-clamp-2 flex-1 text-sm text-zinc-500">
                {s.description}
              </p>
              {deployedIds.has(s.id) ? (
                <span className="inline-flex h-8 w-fit items-center rounded-md border border-zinc-200 px-3 text-sm text-zinc-400">
                  Deployed
                </span>
              ) : (
                <form action={deployServerAction}>
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="serverId" value={s.id} />
                  <button className="inline-flex h-8 items-center rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800">
                    Deploy
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
