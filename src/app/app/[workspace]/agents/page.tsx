import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { listAgents, listProviders } from '@/lib/agents/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { TabBar } from '@/components/dashboard/TabBar';
import { AgentsBrowser } from '@/components/dashboard/agents/AgentsBrowser';
import { ProvidersPanel } from '@/components/dashboard/agents/ProvidersPanel';

export const dynamic = 'force-dynamic';

export default async function AgentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { workspace: slug } = await params;
  const { tab } = await searchParams;
  const t = await getTranslations('console.agents');
  const TABS = [
    { key: 'agents', label: t('title') },
    { key: 'providers', label: t('modelProviders') },
  ];
  const current = TABS.some((t) => t.key === tab) ? tab! : 'agents';

  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const [agents, providers] = await Promise.all([listAgents(ws.id), listProviders(ws.id)]);

  return (
    <>
      <DashboardHeader title={t('title')} />
      <div className="px-8 pt-6">
        <TabBar tabs={TABS} current={current} basePath={`/app/${slug}/agents`} />
      </div>
      {current === 'agents' ? (
        <AgentsBrowser
          slug={slug}
          agents={agents.map((a) => ({
            id: a.id,
            name: a.name,
            providerName: a.provider?.name ?? null,
            model: a.model,
            toolCount: a._count.servers + a._count.skills + a._count.toolkits + a._count.sandboxes,
            subAgentCount: a._count.subAgents,
            conversationCount: a._count.conversations,
          }))}
        />
      ) : (
        <ProvidersPanel
          slug={slug}
          providers={providers.map((p) => ({
            id: p.id,
            name: p.name,
            format: p.format,
            baseUrl: p.baseUrl,
            modelCount: p.models.length,
          }))}
        />
      )}
    </>
  );
}
