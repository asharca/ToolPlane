import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getCurrentUser } from '@/lib/auth/current-user';
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
    redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/market/mcp`)}`);
  }
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');

  return (
    <>
      <DashboardHeader title={t('title')} />
      <div className="border-b border-border bg-card px-4 sm:px-8">
        <MarketTabs slug={workspace.slug} />
      </div>
      {children}
    </>
  );
}
