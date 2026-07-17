import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Bot, Cpu } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import {
  listAgentDeploymentOptions,
  listAgents,
  listAgentSkillOptions,
  listProviders,
} from '@/lib/agents/queries';
import { AgentsBrowser } from '@/components/dashboard/agents/AgentsBrowser';
import { ProvidersPanel } from '@/components/dashboard/agents/ProvidersPanel';
import { listToolkits } from '@/lib/toolkits/queries';
import { effectiveStatus } from '@/lib/process/supervisor';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';

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
    { key: 'agents', label: t('agent'), icon: Bot },
    { key: 'providers', label: t('model'), icon: Cpu },
  ];
  const current = TABS.some((t) => t.key === tab) ? tab! : 'agents';

  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const [agents, providers, deployments, skills, toolkits] = await Promise.all([
    current === 'agents' ? listAgents(ws.id) : Promise.resolve([]),
    listProviders(ws.id),
    current === 'agents' ? listAgentDeploymentOptions(ws.id) : Promise.resolve([]),
    current === 'agents' ? listAgentSkillOptions(ws.id) : Promise.resolve([]),
    current === 'agents' ? listToolkits(ws.id) : Promise.resolve([]),
  ]);

  return (
    <>
      <DashboardHeader title={t('title')} />
      <div className="px-4 pt-5 sm:px-6 lg:px-8">
        <nav className="inline-flex rounded-md border border-border bg-card p-1" aria-label={t('agent')}>
          {TABS.map((item) => {
            const Icon = item.icon;
            const active = item.key === current;
            const href = item.key === 'agents' ? `/app/${slug}/agents` : `/app/${slug}/agents?tab=${item.key}`;
            return (
              <Link
                key={item.key}
                href={href}
                className={`inline-flex h-10 items-center gap-2.5 rounded-md px-4 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                <Icon className="size-[18px] shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
      {current === 'agents' ? (
        <AgentsBrowser
          slug={slug}
          agents={agents.map((a) => ({
            id: a.id,
            name: a.name,
            providerName: a.provider?.name ?? null,
            providerNames: a.modelProviders.map((link) => link.provider.name),
            model: a.model,
            toolCount: a._count.servers + a._count.skills + a._count.toolkits + a._count.sandboxes,
            subAgentCount: a._count.subAgents,
            conversationCount: a._count.conversations,
            runtimeKind: a.runtime?.kind ?? 'native',
            runtimeStatus: a.runtime
              ? ['error', 'setup_required'].includes(a.runtime.status)
                ? a.runtime.status
                : effectiveStatus(a.runtime.sandbox.deploymentId, a.runtime.sandbox.deployment.status)
              : null,
          }))}
          createOptions={{
            providers: providers.map((provider) => ({
              id: provider.id,
              name: provider.name,
              models: provider.models,
            })),
            deployments,
            skills,
            toolkits: toolkits.map((toolkit) => ({
              id: toolkit.id,
              label: toolkit.name,
              status: toolkit.enabled ? 'enabled' : 'disabled',
            })),
          }}
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
            models: p.models,
            modelsFetchedAt: p.modelsFetchedAt?.toLocaleString() ?? null,
          }))}
        />
      )}
    </>
  );
}
