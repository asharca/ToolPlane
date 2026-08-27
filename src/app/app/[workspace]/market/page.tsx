import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  ArrowRight,
  Bot,
  Brain,
  ChevronDown,
  LockKeyhole,
  MessageSquare,
  Plus,
  Plug,
  Wrench,
} from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { db } from '@/lib/db';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { DashboardPage } from '@/components/dashboard/DashboardUI';

export const dynamic = 'force-dynamic';

export default async function MarketPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const [{ workspace: slug }, t, user] = await Promise.all([
    params,
    getTranslations('console.market'),
    getCurrentUser(),
  ]);
  if (!user) redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/market`)}`);
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');

  const base = `/app/${encodeURIComponent(workspace.slug)}`;
  const [deploymentCount, skillCount, toolkitCount, agentCount, assistantCount] = await Promise.all([
    db.deployment.count({
      where: {
        workspaceId: workspace.id,
        OR: [{ source: null }, { source: { not: 'sandbox' } }],
      },
    }),
    db.installedSkill.count({ where: { workspaceId: workspace.id } }),
    db.toolkit.count({ where: { workspaceId: workspace.id } }),
    db.agent.count({ where: { workspaceId: workspace.id } }),
    db.chatAssistant.count({ where: { workspaceId: workspace.id } }),
  ]);
  const inventory = [
    { href: `${base}/mcp`, icon: Plug, label: t('mcp'), count: deploymentCount },
    { href: `${base}/skills`, icon: Brain, label: t('skills'), count: skillCount },
    { href: `${base}/agents`, icon: Bot, label: t('agents'), count: agentCount },
    { href: `${base}/chat`, icon: MessageSquare, label: t('assistants'), count: assistantCount },
    { href: `${base}/toolkits`, icon: Wrench, label: t('toolkits'), count: toolkitCount },
  ];
  const direct = [
    {
      href: `${base}/market/agents`,
      icon: Bot,
      title: t('workAgents'),
      description: t('workAgentsDescription'),
      action: t('browseAgents'),
    },
    {
      href: `${base}/chat`,
      icon: MessageSquare,
      title: t('assistants'),
      description: t('assistantsDescription'),
      action: t('openChat'),
    },
  ];
  const capabilities = [
    {
      href: `${base}/market/mcp`,
      icon: Plug,
      title: t('mcp'),
      description: t('mcpOverviewDescription'),
      action: t('browseMcp'),
    },
    {
      href: `${base}/market/skills`,
      icon: Brain,
      title: t('skills'),
      description: t('skillsOverviewDescription'),
      action: t('browseSkills'),
    },
    {
      href: `${base}/market/toolkits`,
      icon: Wrench,
      title: t('toolkits'),
      description: t('toolkitsOverviewDescription'),
      action: t('browseToolkits'),
    },
  ];
  const additions = [
    { href: `${base}/mcp?create=1`, icon: Plug, label: t('addMcp') },
    { href: `${base}/skills?create=1`, icon: Brain, label: t('addSkill') },
    { href: `${base}/toolkits?create=1`, icon: Wrench, label: t('createToolkit') },
    {
      href: `${base}/agents?create=1&returnTo=${encodeURIComponent(`${base}/market`)}`,
      icon: Bot,
      label: t('createAgent'),
    },
    { href: `${base}/chat?newAssistant=1`, icon: MessageSquare, label: t('createAssistant') },
  ];

  return (
    <DashboardPage className="space-y-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-foreground">{t('overviewTitle')}</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            {t('overviewDescription')}
          </p>
          <p className="mt-2 inline-flex max-w-2xl items-start gap-1.5 text-xs leading-5 text-muted-foreground">
            <LockKeyhole className="mt-0.5 size-3.5 shrink-0" />
            {t('privateByDefault')}
          </p>
        </div>

        <details className="group relative w-full shrink-0 sm:w-auto">
          <summary className="ui-button-primary h-9 w-full cursor-pointer justify-center list-none sm:w-auto [&::-webkit-details-marker]:hidden">
            <Plus className="size-4" />
            {t('addResource')}
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="ui-panel absolute left-0 z-20 mt-2 w-64 max-w-[calc(100vw-2rem)] overflow-hidden p-1 shadow-lg sm:left-auto sm:right-0">
            {additions.map(({ href, icon: Icon, label }) => (
              <Link
                key={href}
                href={href}
                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted"
              >
                <Icon className="size-4 text-muted-foreground" />
                {label}
              </Link>
            ))}
          </div>
        </details>
      </div>

      <section aria-labelledby="workspace-resources-title">
        <div className="mb-3">
          <h2 id="workspace-resources-title" className="text-sm font-semibold text-foreground">
            {t('workspaceResources')}
          </h2>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {t('workspaceResourcesDescription')}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-5">
          {inventory.map(({ href, icon: Icon, label, count }) => (
            <Link
              key={href}
              href={href}
              className="group flex min-w-0 items-center gap-3 bg-card px-3 py-3.5 transition-colors hover:bg-muted/40 last:col-span-2 sm:last:col-span-1"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
              <span className="min-w-0">
                <span className="block truncate text-xs text-muted-foreground">{label}</span>
                <span className="block text-lg font-semibold tabular-nums text-foreground">{count}</span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section aria-labelledby="direct-start-title">
        <h2 id="direct-start-title" className="text-base font-semibold text-foreground">
          {t('directStart')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('directStartDescription')}</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {direct.map(({ href, icon: Icon, title, description, action }) => (
            <Link key={href} href={href} className="ui-panel group flex min-h-36 min-w-0 items-start gap-4 p-5 transition-colors hover:border-foreground/20 hover:bg-muted/30">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-foreground">{title}</span>
                <span className="mt-1 block text-sm leading-5 text-muted-foreground">{description}</span>
                <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-foreground">
                  {action}
                  <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section aria-labelledby="capabilities-title">
        <h2 id="capabilities-title" className="text-base font-semibold text-foreground">
          {t('enhanceCapabilities')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('enhanceCapabilitiesDescription')}</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {capabilities.map(({ href, icon: Icon, title, description, action }) => (
            <Link key={href} href={href} className="ui-panel group flex min-h-52 min-w-0 flex-col p-5 transition-colors hover:border-foreground/20 hover:bg-muted/30 sm:min-h-56 lg:min-h-52">
              <span className="flex size-9 items-center justify-center rounded-md bg-muted text-foreground">
                <Icon className="size-4" />
              </span>
              <span className="mt-4 block font-semibold text-foreground">{title}</span>
              <span className="mt-1 block flex-1 text-sm leading-5 text-muted-foreground">{description}</span>
              <span className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-foreground">
                {action}
                <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      </section>
    </DashboardPage>
  );
}
