import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { ProvidersPanel } from '@/components/dashboard/agents/ProvidersPanel';
import { getCurrentUser } from '@/lib/auth/current-user';
import { listProviders } from '@/lib/agents/queries';
import { piProviderPresets } from '@/lib/agents/provider-catalog';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';
import { getWorkspaceForUser } from '@/lib/workspace/queries';

export const dynamic = 'force-dynamic';

export default async function ProvidersPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const [t, locale] = await Promise.all([
    getTranslations('console.agents'),
    getLocale(),
  ]);
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');

  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const timeZone = resolveUserTimeZone(user);
  const providers = await listProviders(ws.id);
  const presets = piProviderPresets();

  return (
    <>
      <DashboardHeader title={t('modelProviders')} />
      <ProvidersPanel
        slug={slug}
        piProviderPresets={presets}
        providers={providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          format: provider.format,
          baseUrl: provider.baseUrl,
          modelCount: provider.models.length,
          models: provider.models,
          modelsFetchedAt: provider.modelsFetchedAt
            ? formatInTimeZone(
                provider.modelsFetchedAt,
                timeZone,
                { dateStyle: 'medium', timeStyle: 'short' },
                locale,
              )
            : null,
        }))}
      />
    </>
  );
}
