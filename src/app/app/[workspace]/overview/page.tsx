import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  ArrowRight,
  BarChart3,
  Bot,
  Brain,
  CheckCircle2,
  CircleAlert,
  Plug,
  Store,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getDeployments, getInstalledSkills, getWorkspaceForUser } from '@/lib/workspace/queries';
import { listAgents, listProviders } from '@/lib/agents/queries';
import { listSandboxes } from '@/lib/sandboxes/queries';
import { listToolkits } from '@/lib/toolkits/queries';
import { effectiveStatuses } from '@/lib/process/supervisor';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { DashboardPage, DashboardPanel, DashboardToolbar } from '@/components/dashboard/DashboardUI';

const ERROR_STATUSES = new Set([
  'error',
  'copy_failed',
  'restore_failed',
  'restore_cleanup_required',
]);

function isAgentReady(agent: Awaited<ReturnType<typeof listAgents>>[number]) {
  return agent.runtime?.kind === 'hermes'
    ? agent.modelProviders.length > 0
    : Boolean(agent.providerId && agent.model);
}

export const dynamic = 'force-dynamic';

export default async function WorkspaceOverviewPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const [t, user] = await Promise.all([
    getTranslations('console.overview'),
    getCurrentUser(),
  ]);
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const [deployments, skills, agents, providers, sandboxes, toolkits] = await Promise.all([
    getDeployments(ws.id),
    getInstalledSkills(ws.id),
    listAgents(ws.id),
    listProviders(ws.id),
    listSandboxes(ws.id),
    listToolkits(ws.id),
  ]);
  const base = `/app/${encodeURIComponent(slug)}`;
  const deploymentStatuses = effectiveStatuses(deployments);
  const sandboxStatuses = effectiveStatuses(sandboxes.map((sandbox) => ({
    id: sandbox.deploymentId,
    status: sandbox.deployment.status,
  })));
  const runningDeployments = deployments.filter(
    (deployment) => deploymentStatuses.get(deployment.id) === 'running',
  ).length;
  const deploymentProblemCount = deployments.filter((deployment) => (
    ERROR_STATUSES.has(deploymentStatuses.get(deployment.id) ?? deployment.status)
  )).length;
  const sandboxProblemCount = sandboxes.filter((sandbox) => (
    ERROR_STATUSES.has(sandboxStatuses.get(sandbox.deploymentId) ?? sandbox.deployment.status)
  )).length;
  const readyAgents = agents.filter(isAgentReady).length;
  const agentSetupCount = agents.filter((agent) => (
    !isAgentReady(agent)
    || ['error', 'setup_required'].includes(agent.runtime?.status ?? '')
  )).length;
  const enabledToolkits = toolkits.filter((toolkit) => toolkit.enabled).length;

  const resourceCards: Array<{
    href: string;
    label: string;
    value: number;
    detail: string;
    icon: LucideIcon;
  }> = [
    {
      href: `${base}/mcp`,
      label: t('mcpDeployments'),
      value: deployments.length,
      detail: t('runningDeployments', { running: runningDeployments }),
      icon: Plug,
    },
    {
      href: `${base}/skills`,
      label: t('skills'),
      value: skills.length,
      detail: t('skillsReady'),
      icon: Brain,
    },
    {
      href: `${base}/agents`,
      label: t('agents'),
      value: agents.length,
      detail: t('readyAgents', { ready: readyAgents }),
      icon: Bot,
    },
    {
      href: `${base}/toolkits`,
      label: t('toolkits'),
      value: toolkits.length,
      detail: t('enabledToolkits', { enabled: enabledToolkits }),
      icon: Wrench,
    },
  ];
  const attention: Array<{ href: string; title: string; description: string }> = [];
  if (agents.length > 0 && providers.length === 0) {
    attention.push({
      href: `${base}/providers`,
      title: t('noModelProvider'),
      description: t('noModelProviderDescription'),
    });
  } else if (agentSetupCount > 0) {
    attention.push({
      href: `${base}/agents`,
      title: t('agentsNeedSetup', { count: agentSetupCount }),
      description: t('agentsNeedSetupDescription'),
    });
  }
  if (deploymentProblemCount > 0) {
    attention.push({
      href: `${base}/mcp`,
      title: t('mcpNeedsAttention', { count: deploymentProblemCount }),
      description: t('mcpNeedsAttentionDescription'),
    });
  }
  if (sandboxProblemCount > 0) {
    attention.push({
      href: `${base}/sandboxes`,
      title: t('sandboxesNeedAttention', { count: sandboxProblemCount }),
      description: t('sandboxesNeedAttentionDescription'),
    });
  }
  const quickActions: Array<{ href: string; label: string; description: string; icon: LucideIcon }> = [
    {
      href: `${base}/market/mcp`,
      label: t('browseMcp'),
      description: t('browseMcpDescription'),
      icon: Plug,
    },
    {
      href: `${base}/market/skills`,
      label: t('installSkill'),
      description: t('installSkillDescription'),
      icon: Brain,
    },
    {
      href: `${base}/agents`,
      label: t('createAgent'),
      description: t('createAgentDescription'),
      icon: Bot,
    },
    {
      href: `${base}/observability`,
      label: t('viewLogs'),
      description: t('viewLogsDescription'),
      icon: BarChart3,
    },
  ];

  return (
    <>
      <DashboardHeader title={t('title')} />
      <DashboardPage>
        <DashboardToolbar
          actions={(
            <Link href={`${base}/market`} className="ui-button-secondary">
              <Store className="size-4" />
              {t('openMarket')}
            </Link>
          )}
        >
          <p className="text-sm text-muted-foreground">{t('description', { workspace: ws.name })}</p>
        </DashboardToolbar>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {resourceCards.map(({ href, label, value, detail, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="ui-panel group block p-5 transition-colors hover:bg-muted/40"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="text-sm font-medium text-muted-foreground">{label}</span>
                <Icon className="size-4 text-muted-foreground transition-colors group-hover:text-foreground" />
              </div>
              <div className="mt-3 text-3xl font-bold tracking-tight text-foreground">{value}</div>
              <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
            </Link>
          ))}
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <DashboardPanel
            title={t('needsAttention')}
            description={t('needsAttentionDescription')}
          >
            {attention.length > 0 ? (
              <div className="space-y-2">
                {attention.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="group flex items-center gap-3 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-3 transition-colors hover:bg-amber-500/15"
                  >
                    <CircleAlert className="size-5 shrink-0 text-amber-700 dark:text-amber-300" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">{item.title}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{item.description}</span>
                    </span>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </Link>
                ))}
              </div>
            ) : (
              <div className="flex items-start gap-3 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-3 py-3">
                <CheckCircle2 className="size-5 shrink-0 text-emerald-700 dark:text-emerald-300" />
                <span>
                  <span className="block text-sm font-medium text-foreground">{t('allClear')}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{t('allClearDescription')}</span>
                </span>
              </div>
            )}
          </DashboardPanel>

          <DashboardPanel title={t('quickActions')} description={t('quickActionsDescription')}>
            <div className="grid gap-2 sm:grid-cols-2">
              {quickActions.map(({ href, label, description, icon: Icon }) => (
                <Link
                  key={href}
                  href={href}
                  className="group rounded-md border border-border px-3 py-3 transition-colors hover:bg-muted"
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <Icon className="size-4 text-muted-foreground" />
                    {label}
                    <ArrowRight className="ml-auto size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">{description}</span>
                </Link>
              ))}
            </div>
          </DashboardPanel>
        </div>
      </DashboardPage>
    </>
  );
}
