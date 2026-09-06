import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { listAgentChannelConnections } from '@/lib/agents/channel-connections';
import { toAgentChannelConnectionClientView } from '@/lib/agents/channel-connection-client';
import { SettingsModal } from '@/components/dashboard/SettingsModal';
import { SettingsTabs } from '@/components/dashboard/SettingsTabs';
import { AgentMessagingPanel } from '@/components/dashboard/agents/AgentMessagingPanel';

export const dynamic = 'force-dynamic';

export default async function ChannelsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');
  const t = await getTranslations('console.settings');
  const connections = await listAgentChannelConnections(workspace.id);
  return (
    <SettingsModal title={t('title')} fallbackHref={`/app/${slug}/chat`}>
      <div className="flex h-full min-h-0 flex-col md:flex-row">
        <SettingsTabs slug={slug} />
        <div className="min-h-0 min-w-0 flex-1">
          <AgentMessagingPanel slug={slug} connections={connections.map(toAgentChannelConnectionClientView)} />
        </div>
      </div>
    </SettingsModal>
  );
}
