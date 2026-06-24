import Link from 'next/link';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { Download, Server as ServerIcon } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import {
  getWorkspaceForUser,
  getDeployments,
  getInstalledSkills,
} from '@/lib/workspace/queries';
import { liveStatus } from '@/lib/process/supervisor';
import { listMcpTools } from '@/lib/process/mcp-client';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { ReadyToConnectBanner } from '@/components/dashboard/ReadyToConnectBanner';
import { TabBar } from '@/components/dashboard/TabBar';

export const dynamic = 'force-dynamic';

export default async function MyToolkitPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { workspace: slug } = await params;
  const { tab } = await searchParams;

  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const [deployments, skills] = await Promise.all([
    getDeployments(ws.id),
    getInstalledSkills(ws.id),
  ]);

  const toolCounts = await Promise.all(
    deployments.map(async (d) =>
      liveStatus(d.id) === 'running'
        ? (await listMcpTools(d.id)).length
        : null,
    ),
  );

  const h = await headers();
  const host = h.get('host') ?? 'localhost:3000';
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  const endpoint = `${proto}://${host}/api/v1/workspaces/${slug}/manifest`;

  const base = `/app/${slug}/toolkits/me`;
  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'mcps', label: 'MCPs', count: deployments.length },
    { key: 'skills', label: 'Skills', count: skills.length },
  ];
  const current = tabs.some((t) => t.key === tab) ? tab! : 'overview';

  return (
    <>
      <DashboardHeader
        breadcrumb={[
          { label: 'Toolkits', href: `/app/${slug}/toolkits` },
          { label: 'me' },
        ]}
        actions={
          <a
            href={`/api/v1/workspaces/${slug}/manifest`}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            <Download className="size-4" />
            Install
          </a>
        }
      />
      <div className="space-y-6 px-8 py-6">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
              My Toolkit
            </h1>
            <span className="inline-flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-300">
              <span className="size-2 rounded-full bg-emerald-500" />
              Enabled
            </span>
          </div>
          <code className="block font-mono text-xs text-zinc-400 dark:text-zinc-500">
            {endpoint}
          </code>
        </div>

        <TabBar tabs={tabs} current={current} basePath={base} />

        {current === 'overview' ? (
          <div className="space-y-5">
            <ReadyToConnectBanner noun="toolkit" />

            <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
              <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Connected MCP servers
                </h2>
                <span className="text-sm text-zinc-400">
                  {deployments.length}
                </span>
              </header>
              {deployments.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  No servers connected yet.
                </p>
              ) : (
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {deployments.map((d, i) => (
                    <li
                      key={d.id}
                      className="flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <Link
                        href={`/app/${slug}/mcp/${d.id}`}
                        className="flex items-center gap-2.5 text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                      >
                        <span className="flex size-7 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
                          <ServerIcon className="size-4 text-zinc-500" />
                        </span>
                        {d.server.name}
                      </Link>
                      <span className="text-sm text-zinc-400">
                        {toolCounts[i] === null
                          ? 'stopped'
                          : `${toolCounts[i]} tools`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
              <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Skills
                </h2>
                <span className="text-sm text-zinc-400">{skills.length}</span>
              </header>
              {skills.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  No skills attached yet
                </p>
              ) : (
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {skills.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <Link
                        href={`/app/${slug}/skills/${s.id}`}
                        className="text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                      >
                        {s.skill.name}
                      </Link>
                      <a
                        href={`/api/v1/skills/${s.id}/download`}
                        className="text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                      >
                        SKILL.md
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : null}

        {current === 'mcps' ? (
          <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
            {deployments.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
                No servers connected yet.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {deployments.map((d, i) => (
                  <li
                    key={d.id}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <Link
                      href={`/app/${slug}/mcp/${d.id}`}
                      className="flex items-center gap-2.5 text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                    >
                      <span className="flex size-7 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
                        <ServerIcon className="size-4 text-zinc-500" />
                      </span>
                      {d.server.name}
                    </Link>
                    <span className="text-sm text-zinc-400">
                      {toolCounts[i] === null
                        ? 'stopped'
                        : `${toolCounts[i]} tools`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {current === 'skills' ? (
          <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
            {skills.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
                No skills attached yet
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {skills.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <Link
                      href={`/app/${slug}/skills/${s.id}`}
                      className="text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                    >
                      {s.skill.name}
                    </Link>
                    <a
                      href={`/api/v1/skills/${s.id}/download`}
                      className="text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                    >
                      SKILL.md
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
    </>
  );
}
