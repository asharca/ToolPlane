import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { listWorkspaceMarketCopies } from '@/lib/market/copy-updates';
import { countWorkspaceMarketUpdates } from '@/lib/market/skills';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { MarketTabs } from '@/components/dashboard/MarketTabs';

export const dynamic = 'force-dynamic';

export default async function MarketLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const [{ workspace: slug }, t] = await Promise.all([
    params,
    getTranslations('console.market'),
  ]);
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/market`)}`);
  }
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');
  const [trackedUpdateCount, copies] = await Promise.all([
    countWorkspaceMarketUpdates(workspace.id),
    listWorkspaceMarketCopies(workspace.id),
  ]);
  const updateCount = trackedUpdateCount
    + copies.agents.filter((item) => item.updateAvailable).length
    + copies.assistants.filter((item) => item.updateAvailable).length;

  return (
    <>
      <DashboardHeader title={t('title')} />
      <div className="bg-card px-4 sm:px-8">
        <MarketTabs slug={workspace.slug} updateCount={updateCount} />
      </div>
      {children}
    </>
  );
}
