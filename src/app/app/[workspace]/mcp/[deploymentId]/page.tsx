import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { db } from '@/lib/db';
import { liveStatus } from '@/lib/process/supervisor';
import { listMcpTools } from '@/lib/process/mcp-client';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { ToolPlayground } from '@/components/dashboard/ToolPlayground';

export const dynamic = 'force-dynamic';

export default async function DeploymentInspectorPage({
  params,
}: {
  params: Promise<{ workspace: string; deploymentId: string }>;
}) {
  const { workspace: slug, deploymentId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const dep = await db.deployment.findFirst({
    where: { id: deploymentId, workspaceId: ws.id },
    include: { server: { select: { name: true, slug: true } } },
  });
  if (!dep) notFound();

  const status = liveStatus(deploymentId) ?? dep.status;
  const running = status === 'running';
  const tools = running ? await listMcpTools(deploymentId) : [];
  const endpoint = `/api/v1/mcp/${deploymentId}/rpc`;

  return (
    <>
      <DashboardHeader
        title={dep.server.name}
        actions={
          <Link
            href={`/app/${slug}/mcp`}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <ArrowLeft className="size-4" />
            Back
          </Link>
        }
      />
      <div className="space-y-8 px-8 py-6">
        <div className="flex flex-wrap items-center gap-4">
          <StatusBadge status={status} />
          <Link
            href={`/server/${dep.server.slug}`}
            className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
          >
            View in directory
          </Link>
        </div>

        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Gateway endpoint
          </h2>
          <p className="mb-2 text-sm text-zinc-500 dark:text-zinc-400">
            Send JSON-RPC 2.0 requests with your API token to reach this server.
          </p>
          <pre className="overflow-x-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
{`POST ${endpoint}
Authorization: Bearer <your-api-token>
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/list"}`}
          </pre>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Tools {tools.length > 0 ? `(${tools.length})` : ''}
          </h2>
          {running ? (
            <ToolPlayground deploymentId={deploymentId} tools={tools} />
          ) : (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              This deployment is {status}. Start it to inspect and run its tools.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
