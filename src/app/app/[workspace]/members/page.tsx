import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getWorkspaceMembers } from '@/lib/workspace/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { FeatureGateCard } from '@/components/dashboard/FeatureGateCard';

export const dynamic = 'force-dynamic';

function fmt(d: Date) {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default async function MembersPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const members = await getWorkspaceMembers(ws.id);

  return (
    <>
      <DashboardHeader title="Members" />
      <div className="space-y-10 px-8 py-10">
        <FeatureGateCard
          kicker="Members"
          badge="Team plan"
          title="Invite your team"
          description="Add teammates, manage roles, and share servers across your workspace. Available on the Team plan."
          bullets={[
            'Invite teammates with admin, member, and owner roles',
            'Share toolkits, MCP servers, and skills across your org',
            'Pooled credits, unlimited skills, and version history',
          ]}
          primaryLabel="Upgrade to Team"
          secondaryLabel="View pricing"
          secondaryHref={`/app/${slug}/settings`}
        />

        <section className="mx-auto max-w-xl">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
            Current members ({members.length})
          </h3>
          <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Member</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {members.map((m) => (
                  <tr key={m.id}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="flex size-7 items-center justify-center rounded-full bg-zinc-900 text-[11px] font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">
                          {(m.user.name ?? m.user.email).slice(0, 1).toUpperCase()}
                        </span>
                        <div>
                          <div className="font-medium text-zinc-900 dark:text-zinc-100">
                            {m.user.name ?? m.user.email.split('@')[0]}
                          </div>
                          <div className="text-xs text-zinc-500 dark:text-zinc-400">
                            {m.user.email}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded-full border border-zinc-200 px-2 py-0.5 text-xs capitalize text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
                        {m.role}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                      {fmt(m.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
