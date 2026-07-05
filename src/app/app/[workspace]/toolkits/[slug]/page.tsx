import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { Download, Server as ServerIcon, Brain, Plus, X } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import {
  getToolkitBySlug,
  getOrCreateDefaultToolkit,
  getToolkitComposables,
} from '@/lib/toolkits/queries';
import { getOrCreateToolkitInstallLink } from '@/lib/toolkits/install-link';
import { originFromHeaders } from '@/lib/http/origin';
import { liveStatus } from '@/lib/process/supervisor';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { skillLabel } from '@/lib/workspace/skill-label';
import { listMcpTools } from '@/lib/process/mcp-client';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { ToolkitInstall } from '@/components/dashboard/ToolkitInstall';
import { TabBar } from '@/components/dashboard/TabBar';
import {
  addServerToToolkitAction,
  removeServerFromToolkitAction,
  addSkillToToolkitAction,
  removeSkillFromToolkitAction,
} from '@/lib/toolkits/actions';

export const dynamic = 'force-dynamic';

export default async function ToolkitDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; slug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { workspace: wsSlug, slug: toolkitSlug } = await params;
  const { tab } = await searchParams;

  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(wsSlug, user.id);
  if (!ws) redirect('/app');

  if (toolkitSlug === 'me') await getOrCreateDefaultToolkit(ws.id);
  const toolkit = await getToolkitBySlug(ws.id, toolkitSlug);
  if (!toolkit) notFound();

  const composables = await getToolkitComposables(ws.id, toolkit.id);

  const toolCounts = await Promise.all(
    toolkit.servers.map(async (s) =>
      liveStatus(s.deployment.id) === 'running'
        ? (await listMcpTools(s.deployment.id)).length
        : null,
    ),
  );

  const origin = originFromHeaders(await headers());
  const installLink = await getOrCreateToolkitInstallLink(toolkit.id, user.id);
  const installUrl = `${origin}/install/${installLink.id}`;
  const uninstallUrl = `${installUrl}/uninstall`;
  const mcpUrl = `${origin}/api/v1/workspaces/${wsSlug}/toolkits/${toolkitSlug}/mcp`;

  const base = `/app/${wsSlug}/toolkits/${toolkitSlug}`;
  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'mcps', label: 'MCPs', count: toolkit.servers.length },
    { key: 'skills', label: 'Skills', count: toolkit.skills.length },
  ];
  const current = tabs.some((t) => t.key === tab) ? tab! : 'overview';

  const cardHeader =
    'flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800';
  const rowAddButton =
    'inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 px-2 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800';

  return (
    <>
      <DashboardHeader
        breadcrumb={[
          { label: 'Toolkits', href: `/app/${wsSlug}/toolkits` },
          { label: toolkitSlug },
        ]}
        actions={
          <a
            href={installUrl}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            <Download className="size-4" />
            Install script
          </a>
        }
      />
      <div className="space-y-6 px-8 py-6">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
              {toolkit.name}
            </h1>
            <span className="inline-flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-300">
              <span
                className={`size-2 rounded-full ${
                  toolkit.enabled ? 'bg-emerald-500' : 'bg-zinc-400'
                }`}
              />
              {toolkit.enabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <code className="block font-mono text-xs text-zinc-400 dark:text-zinc-500">
            {installUrl}
          </code>
        </div>

        <TabBar tabs={tabs} current={current} basePath={base} />

        {current === 'overview' ? (
          <div className="space-y-5">
            <ToolkitInstall
              installUrl={installUrl}
              uninstallUrl={uninstallUrl}
              mcpUrl={mcpUrl}
              toolkitSlug={toolkitSlug}
              serverCount={toolkit.servers.length}
              skillCount={toolkit.skills.length}
            />

            <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
              <header className={cardHeader}>
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Connected MCP
                </h2>
                <span className="text-sm text-muted-foreground">
                  {toolkit.servers.length}
                </span>
              </header>
              {toolkit.servers.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  No servers attached yet. Add some from the MCPs tab.
                </p>
              ) : (
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {toolkit.servers.map((s, i) => (
                    <li
                      key={s.id}
                      className="flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <Link
                        href={`/app/${wsSlug}/mcp/${s.deployment.id}`}
                        className="flex items-center gap-2.5 text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                      >
                        <span className="flex size-7 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
                          <ServerIcon className="size-4 text-muted-foreground" />
                        </span>
                        {deploymentLabel(s.deployment).name}
                      </Link>
                      <span className="text-sm text-muted-foreground">
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
              <header className={cardHeader}>
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Skills
                </h2>
                <span className="text-sm text-muted-foreground">
                  {toolkit.skills.length}
                </span>
              </header>
              {toolkit.skills.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  No skills attached yet
                </p>
              ) : (
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {toolkit.skills.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <Link
                        href={`/app/${wsSlug}/skills/${s.installedSkill.id}`}
                        className="flex items-center gap-2.5 text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                      >
                        <span className="flex size-7 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
                          <Brain className="size-4 text-muted-foreground" />
                        </span>
                        {skillLabel(s.installedSkill).name}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : null}

        {current === 'mcps' ? (
          <div className="space-y-5">
            <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
              <header className={cardHeader}>
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  In this toolkit
                </h2>
                <span className="text-sm text-muted-foreground">
                  {toolkit.servers.length}
                </span>
              </header>
              {toolkit.servers.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  No servers in this toolkit yet.
                </p>
              ) : (
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {toolkit.servers.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <span className="flex items-center gap-2.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        <span className="flex size-7 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
                          <ServerIcon className="size-4 text-muted-foreground" />
                        </span>
                        {deploymentLabel(s.deployment).name}
                      </span>
                      <form action={removeServerFromToolkitAction}>
                        <input type="hidden" name="workspace" value={wsSlug} />
                        <input type="hidden" name="toolkitSlug" value={toolkitSlug} />
                        <input type="hidden" name="deploymentId" value={s.deployment.id} />
                        <button className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:text-red-600">
                          <X className="size-3.5" />
                          Remove
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
              <header className={cardHeader}>
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Available MCP
                </h2>
                <span className="text-sm text-muted-foreground">
                  {composables.deployments.length}
                </span>
              </header>
              {composables.deployments.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  Every deployed server is already in this toolkit.{' '}
                  <Link
                    href={`/app/${wsSlug}/mcp/new`}
                    className="text-zinc-700 underline dark:text-zinc-300"
                  >
                    Deploy more
                  </Link>
                  .
                </p>
              ) : (
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {composables.deployments.map((d) => (
                    <li
                      key={d.id}
                      className="flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <span className="flex items-center gap-2.5 text-sm text-zinc-700 dark:text-zinc-300">
                        <span className="flex size-7 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
                          <ServerIcon className="size-4 text-muted-foreground" />
                        </span>
                        {deploymentLabel(d).name}
                      </span>
                      <form action={addServerToToolkitAction}>
                        <input type="hidden" name="workspace" value={wsSlug} />
                        <input type="hidden" name="toolkitSlug" value={toolkitSlug} />
                        <input type="hidden" name="deploymentId" value={d.id} />
                        <button className={rowAddButton}>
                          <Plus className="size-3.5" />
                          Add
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : null}

        {current === 'skills' ? (
          <div className="space-y-5">
            <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
              <header className={cardHeader}>
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  In this toolkit
                </h2>
                <span className="text-sm text-muted-foreground">
                  {toolkit.skills.length}
                </span>
              </header>
              {toolkit.skills.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  No skills in this toolkit yet.
                </p>
              ) : (
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {toolkit.skills.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <span className="flex items-center gap-2.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        <span className="flex size-7 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
                          <Brain className="size-4 text-muted-foreground" />
                        </span>
                        {skillLabel(s.installedSkill).name}
                      </span>
                      <form action={removeSkillFromToolkitAction}>
                        <input type="hidden" name="workspace" value={wsSlug} />
                        <input type="hidden" name="toolkitSlug" value={toolkitSlug} />
                        <input
                          type="hidden"
                          name="installedSkillId"
                          value={s.installedSkill.id}
                        />
                        <button className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:text-red-600">
                          <X className="size-3.5" />
                          Remove
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
              <header className={cardHeader}>
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Available skills
                </h2>
                <span className="text-sm text-muted-foreground">
                  {composables.skills.length}
                </span>
              </header>
              {composables.skills.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  Every installed skill is already in this toolkit.{' '}
                  <Link
                    href={`/app/${wsSlug}/skills/new`}
                    className="text-zinc-700 underline dark:text-zinc-300"
                  >
                    Install more
                  </Link>
                  .
                </p>
              ) : (
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {composables.skills.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <span className="flex items-center gap-2.5 text-sm text-zinc-700 dark:text-zinc-300">
                        <span className="flex size-7 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
                          <Brain className="size-4 text-muted-foreground" />
                        </span>
                        {skillLabel(s).name}
                      </span>
                      <form action={addSkillToToolkitAction}>
                        <input type="hidden" name="workspace" value={wsSlug} />
                        <input type="hidden" name="toolkitSlug" value={toolkitSlug} />
                        <input type="hidden" name="installedSkillId" value={s.id} />
                        <button className={rowAddButton}>
                          <Plus className="size-3.5" />
                          Add
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </>
  );
}
