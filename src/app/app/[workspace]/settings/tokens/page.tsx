import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { listApiTokens } from '@/lib/auth/tokens';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { SettingsTabs } from '@/components/dashboard/SettingsTabs';
import { TokenManager, type TokenView } from '@/components/dashboard/TokenManager';
import { DashboardPage } from '@/components/dashboard/DashboardUI';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';

export const dynamic = 'force-dynamic';

function displayDate(
  d: Date | null,
  timeZone: string,
  locale: string,
): string | null {
  return d
    ? formatInTimeZone(d, timeZone, { dateStyle: 'medium' }, locale)
    : null;
}

export default async function TokensPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const [t, locale] = await Promise.all([
    getTranslations('console.tokens'),
    getLocale(),
  ]);
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const timeZone = resolveUserTimeZone(user);

  const tokens = await listApiTokens(user.id);
  const view: TokenView[] = tokens.map((t) => ({
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    lastUsedAt: displayDate(t.lastUsedAt, timeZone, locale),
    createdAt: displayDate(t.createdAt, timeZone, locale) ?? '',
  }));

  return (
    <>
      <DashboardHeader title={t('settings')} />
      <DashboardPage className="max-w-2xl">
        <SettingsTabs slug={slug} />
        <TokenManager tokens={view} workspaceSlug={slug} />
      </DashboardPage>
    </>
  );
}
