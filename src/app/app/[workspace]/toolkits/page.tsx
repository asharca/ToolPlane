import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plug, Brain, Download } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import {
  getWorkspaceForUser,
  getDeployments,
  getInstalledSkills,
} from '@/lib/workspace/queries';
import { liveStatus } from '@/lib/process/supervisor';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { StatusBadge } from '@/components/dashboard/StatusBadge';

export const dynamic = 'force-dynamic';

export default async function ToolkitsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const [deployments, skills] = await Promise.all([
    getDeployments(ws.id),
    getInstalledSkills(ws.id),
  ]);

  return (
    <>
      <DashboardHeader
        title="Toolkits"
        actions={
          <a
            href={`/api/v1/workspaces/${slug}/manifest`}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            <Download className="size-4" />
            Export manifest
          </a>
        }
      />
      <div className="px-8 py-6">
        <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
          Your workspace toolkit bundles every deployed MCP server and installed
          skill into one manifest your agents can load.
        </p>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
            <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <Plug className="size-4 text-zinc-500" />
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                MCP Servers ({deployments.length})
              </h2>
            </header>
            {deployments.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                No servers deployed.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {deployments.map((d) => (
                  <li
                    key={d.id}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <Link
                      href={`/app/${slug}/mcp/${d.id}`}
                      className="truncate text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                    >
                      {d.server.name}
                    </Link>
                    <StatusBadge status={liveStatus(d.id) ?? d.status} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
            <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <Brain className="size-4 text-zinc-500" />
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Skills ({skills.length})
              </h2>
            </header>
            {skills.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                No skills installed.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {skills.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <Link
                      href={`/tools/skills/${s.skill.slug}`}
                      className="truncate text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                    >
                      {s.skill.name}
                    </Link>
                    <a
                      href={`/api/v1/skills/${s.id}/download`}
                      className="shrink-0 text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                    >
                      SKILL.md
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
