import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getWorkspaceMembers } from '@/lib/workspace/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { FeatureGateCard } from '@/components/dashboard/FeatureGateCard';
import {
  DashboardPage,
  DashboardSection,
  DashboardTable,
} from '@/components/dashboard/DashboardUI';

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
  const t = await getTranslations('console.members');
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const members = await getWorkspaceMembers(ws.id);

  return (
    <>
      <DashboardHeader title={t('members')} />
      <DashboardPage className="space-y-10 py-10">
        <FeatureGateCard
          kicker="Members"
          badge="Team plan"
          title={t('inviteYourTeam')}
          description={t('addTeammatesManageRolesAndShareServersAcrossYourWorkspaceAvailableOnTheTeamPlan')}
          bullets={[
            'Invite teammates with admin, member, and owner roles',
            'Share toolkits, MCP, and skills across your org',
            'Pooled credits, unlimited skills, and version history',
          ]}
          primaryLabel="Upgrade to Team"
          secondaryLabel="View pricing"
          secondaryHref={`/app/${slug}/settings`}
        />

        <div className="mx-auto w-full max-w-xl">
          <DashboardSection title={t('currentMembers')} count={members.length}>
            <DashboardTable
              headers={[
                { label: 'Member' },
                { label: 'Role' },
                { label: 'Joined' },
              ]}
              minWidth="34rem"
            >
              {members.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="flex size-7 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                        {(m.user.name ?? m.user.email).slice(0, 1).toUpperCase()}
                      </span>
                      <div>
                        <div className="font-medium text-foreground">
                          {m.user.name ?? m.user.email.split('@')[0]}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {m.user.email}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs capitalize text-muted-foreground">
                      {m.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {fmt(m.createdAt)}
                  </td>
                </tr>
              ))}
            </DashboardTable>
          </DashboardSection>
        </div>
      </DashboardPage>
    </>
  );
}
