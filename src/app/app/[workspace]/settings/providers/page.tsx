import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { SettingsModal } from '@/components/dashboard/SettingsModal';
import { SettingsTabs } from '@/components/dashboard/SettingsTabs';
import { ProvidersPanel } from '@/components/dashboard/agents/ProvidersPanel';
import { getCurrentUser } from '@/lib/auth/current-user';
import { listProviders } from '@/lib/agents/queries';
import { piProviderPresets } from '@/lib/agents/provider-catalog';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';
import { getWorkspaceForUser } from '@/lib/workspace/queries';

export const dynamic = 'force-dynamic';

export default async function SettingsProvidersPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const [t, locale, user] = await Promise.all([
    getTranslations('console.settings'),
    getLocale(),
    getCurrentUser(),
  ]);
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const timeZone = resolveUserTimeZone(user);
  const providers = await listProviders(ws.id);

  return (
    <SettingsModal title={t('title')} fallbackHref={`/app/${slug}/chat`}>
      <div className="flex h-full min-h-0 flex-col md:flex-row">
        <SettingsTabs slug={slug} />
        <div className="min-w-0 flex-1 overflow-y-auto p-5 sm:p-6 lg:p-8">
          <ProvidersPanel
            slug={slug}
            piProviderPresets={piProviderPresets()}
            embedded
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
        </div>
      </div>
    </SettingsModal>
  );
}
