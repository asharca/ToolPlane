import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getDeployments } from '@/lib/workspace/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { removeDeploymentAction } from '@/lib/workspace/actions';

export const dynamic = 'force-dynamic';

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default async function McpServersPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const deployments = await getDeployments(ws.id);

  return (
    <>
      <DashboardHeader
        title="MCP Servers"
        actions={
          <Link
            href={`/app/${slug}/mcp/new`}
            className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800"
          >
            Browse MCPs
          </Link>
        }
      />
      <div className="px-8 py-6">
        <div className="mb-6 flex items-center justify-between">
          <p className="text-sm text-zinc-500">Servers deployed to your org.</p>
          <span className="text-sm text-zinc-400">
            {deployments.length} server{deployments.length === 1 ? '' : 's'}
          </span>
        </div>

        {deployments.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-zinc-200 py-20 text-center">
            <p className="text-sm text-zinc-500">No servers deployed yet.</p>
            <Link
              href={`/app/${slug}/mcp/new`}
              className="mt-4 inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800"
            >
              Browse MCPs
            </Link>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-200">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Server</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {deployments.map((d) => (
                  <tr key={d.id} className="transition-colors hover:bg-zinc-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        {d.server.iconUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={d.server.iconUrl}
                            alt=""
                            width={20}
                            height={20}
                            className="size-5 rounded object-cover"
                          />
                        ) : (
                          <span className="size-5 rounded bg-zinc-200" />
                        )}
                        <Link
                          href={`/server/${d.server.slug}`}
                          className="font-medium text-zinc-900 hover:underline"
                        >
                          {d.server.name}
                        </Link>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={d.status} />
                    </td>
                    <td className="px-4 py-3 text-zinc-500">
                      {formatDate(d.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <form action={removeDeploymentAction}>
                        <input type="hidden" name="workspace" value={slug} />
                        <input type="hidden" name="deploymentId" value={d.id} />
                        <button className="text-xs text-zinc-400 transition-colors hover:text-red-600">
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
