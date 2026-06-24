import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Wrench } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import {
  getWorkspaceForUser,
  getDeployments,
  getInstalledSkills,
} from '@/lib/workspace/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';

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
      <DashboardHeader title="Toolkits" />
      <div className="px-8 py-6">
        <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
          A toolkit bundles your deployed MCP servers and installed skills into
          one manifest your agents can load.
        </p>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Link
            href={`/app/${slug}/toolkits/me`}
            className="group rounded-lg border border-zinc-200 p-5 transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:bg-zinc-900/50"
          >
            <div className="flex items-center justify-between">
              <span className="flex size-9 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
                <Wrench className="size-4 text-zinc-500" />
              </span>
              <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                Enabled
              </span>
            </div>
            <h2 className="mt-4 text-sm font-semibold text-zinc-900 group-hover:underline dark:text-zinc-100">
              My Toolkit
            </h2>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {deployments.length} MCP{deployments.length === 1 ? '' : 's'} ·{' '}
              {skills.length} skill{skills.length === 1 ? '' : 's'}
            </p>
          </Link>
        </div>
      </div>
    </>
  );
}
