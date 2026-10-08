
import { AnimatedBadge } from '@/components/motion/animated-badge';

import { ButtonLink } from '@/components/motion/button';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  ArrowUpRight,
  Bot,
  Brain,
  MessageSquare,
  PackageCheck,
  Plug,
  Puzzle,
  RotateCw,
  Trash2,
  Wrench,
} from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { listAgents } from '@/lib/agents/queries';
import { uninstallAgentMarketCopyAction } from '@/lib/agents/actions';
import {
  ignoreMarketUpdateAction,
  removeAssistantMarketCopyAction,
  removeMarketInstallAction,
  updateMarketInstallAction,
} from '@/lib/market/actions';
import { listWorkspaceMarketCopies } from '@/lib/market/copy-updates';
import { listWorkspaceMarketInstalls } from '@/lib/market/skills';
import { listToolkits } from '@/lib/toolkits/queries';
import {
  getDeployments,
  getInstalledSkills,
  getWorkspaceForUser,
} from '@/lib/workspace/queries';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { skillLabel } from '@/lib/workspace/skill-label';
import { DashboardEmptyState, DashboardPage } from '@/components/dashboard/DashboardUI';
import { ConfirmSubmitButton } from '@/components/dashboard/ConfirmSubmitButton';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { PiPackageDetails } from '@/components/dashboard/market/PiPackageDetails';
import type { PiPackageSummary } from '@/lib/market/pi-package-manifest';
import { listPiPackageClientInstallations } from '@/lib/pi-packages/installations';

export const dynamic = 'force-dynamic';

type ResourceKind = 'mcp' | 'skill' | 'agent' | 'assistant' | 'toolkit' | 'pi-package';

type InstalledResource = {
  key: string;
  name: string;
  kind: ResourceKind;
  source: string;
  sourceDetail?: string | null;
  status: string;
  href: string;
  updatedAt: Date;
  piPackage?: {
    snapshot: PiPackageSummary;
    checksum: string;
    available: boolean;
    automaticReview: boolean;
    bindings: Array<{ agentId: string; name: string; version: number; releaseId: string; reviewStatus: string; checksum: string }>;
  };
  market?: {
    installId: string;
    currentVersion: number;
    latestVersion: number | null;
    latestReleaseId: string | null;
    currentReleaseId: string;
    updateAvailable: boolean;
    updateIgnored: boolean;
    releaseNotes: string | null;
    detailHref: string;
  };
  copy?: {
    agentId?: string;
    assistantId?: string;
    currentVersion: number;
    latestVersion: number | null;
    latestReleaseId: string | null;
    updateAvailable: boolean;
    releaseNotes: string | null;
    updateHref: string;
  };
};

function statusTone(status: string) {
  if (['error', 'failed', 'copy_failed', 'restore_failed'].includes(status)) return 'bg-destructive';
  if (['ready', 'running', 'published', 'enabled'].includes(status)) return 'bg-muted/35';
  if (['modified', 'installing', 'provisioning', 'setup_required'].includes(status)) return 'bg-muted/35';
  return 'bg-muted';
}

export default async function InstalledMarketPage({
  params,
  searchParams = Promise.resolve({}),
}: {
  params: Promise<{ workspace: string }>;
  searchParams?: Promise<{ error?: string | string[] }>;
}) {
  const [{ workspace: slug }, query, t, common, user] = await Promise.all([
    params,
    searchParams,
    getTranslations('console.market'),
    getTranslations('common'),
    getCurrentUser(),
  ]);
  if (!user) redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/market/installed`)}`);
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');

  const [marketInstalls, copies, deployments, skills, toolkits, agents, clientInstallations] = await Promise.all([
    listWorkspaceMarketInstalls(workspace.id),
    listWorkspaceMarketCopies(workspace.id),
    getDeployments(workspace.id),
    getInstalledSkills(workspace.id),
    listToolkits(workspace.id),
    listAgents(workspace.id),
    listPiPackageClientInstallations({ workspaceId: workspace.id, userId: user.id }),
  ]);
  const base = `/app/${encodeURIComponent(workspace.slug)}`;
  const tracked = {
    deployments: new Set(marketInstalls.flatMap((item) => item.deploymentId ? [item.deploymentId] : [])),
    skills: new Set(marketInstalls.flatMap((item) => item.installedSkillId ? [item.installedSkillId] : [])),
    toolkits: new Set(marketInstalls.flatMap((item) => item.toolkitId ? [item.toolkitId] : [])),
    agents: new Set([
      ...marketInstalls.flatMap((item) => item.agentId ? [item.agentId] : []),
      ...copies.agents.map((item) => item.resourceId),
    ]),
  };

  const resources: InstalledResource[] = marketInstalls.map((install) => {
    const kind = install.listing.kind as ResourceKind;
    const href = kind === 'pi-package' ? `${base}/market/items/${encodeURIComponent(install.listing.namespace)}/${encodeURIComponent(install.listing.slug)}` : install.deploymentId
      ? `${base}/mcp/${encodeURIComponent(install.deploymentId)}`
      : install.installedSkillId
        ? `${base}/skills/${encodeURIComponent(install.installedSkillId)}`
        : install.toolkitId
          ? `${base}/toolkits`
          : install.agentId
            ? `${base}/agents/${encodeURIComponent(install.agentId)}`
            : `${base}/market/installed`;
    const latest = install.listing.latestRelease;
    const hasNewerRelease = Boolean(latest && latest.id !== install.currentReleaseId);
    return {
      key: `market-${install.id}`,
      name: install.listing.name,
      kind,
      source: 'market',
      sourceDetail: `${install.listing.namespace}/${install.listing.slug}`,
      status: install.status,
      href,
      updatedAt: install.updatedAt,
      ...(install.piPackage ? { piPackage: {
        snapshot: install.piPackage,
        checksum: install.currentRelease.checksum ?? '',
        available: install.listing.status === 'published' && install.currentRelease.reviewStatus === 'approved',
        automaticReview: install.currentRelease.reviewPolicy === 'official-directory',
        bindings: install.agentPiPackages.map((binding) => ({ agentId: binding.agentId, name: binding.agent.name, version: binding.release.version, releaseId: binding.releaseId, reviewStatus: binding.release.reviewStatus, checksum: binding.release.checksum })),
      } } : {}),
      market: {
        installId: install.id,
        currentVersion: install.currentRelease.version,
        latestVersion: latest?.version ?? null,
        latestReleaseId: latest?.id ?? null,
        currentReleaseId: install.currentReleaseId,
        updateAvailable: install.updateAvailable,
        updateIgnored: hasNewerRelease && !install.updateAvailable,
        releaseNotes: latest?.releaseNotes ?? null,
        detailHref: `${base}/market/items/${encodeURIComponent(install.listing.namespace)}/${encodeURIComponent(install.listing.slug)}`,
      },
    };
  });

  for (const copy of [...copies.agents, ...copies.assistants]) {
    const isAgent = copy.kind === 'agent';
    const latestReleaseId = copy.latestReleaseId;
    resources.push({
      key: `copy-${copy.kind}-${copy.id}`,
      name: copy.name,
      kind: copy.kind,
      source: 'market',
      sourceDetail: copy.sourceDetail,
      status: copy.status,
      href: isAgent
        ? `${base}/agents/${encodeURIComponent(copy.resourceId)}`
        : `${base}/chat?assistant=${encodeURIComponent(copy.resourceId)}`,
      updatedAt: copy.updatedAt,
      copy: {
        ...(isAgent ? { agentId: copy.resourceId } : {}),
        ...(!isAgent ? { assistantId: copy.resourceId } : {}),
        currentVersion: copy.currentVersion,
        latestVersion: copy.latestVersion,
        latestReleaseId,
        updateAvailable: copy.updateAvailable,
        releaseNotes: copy.releaseNotes,
        updateHref: isAgent
          ? `${base}/market/agents/${encodeURIComponent(copy.listingId)}`
          : `${base}/chat?newAssistant=1${latestReleaseId ? `&template=${encodeURIComponent(latestReleaseId)}` : ''}`,
      },
    });
  }

  for (const deployment of deployments) {
    if (tracked.deployments.has(deployment.id)) continue;
    const label = deploymentLabel(deployment);
    resources.push({
      key: `mcp-${deployment.id}`,
      name: label.name,
      kind: 'mcp',
      source: label.source,
      sourceDetail: label.ref ?? deployment.server?.slug,
      status: deployment.status,
      href: `${base}/mcp/${encodeURIComponent(deployment.id)}`,
      updatedAt: deployment.updatedAt,
    });
  }
  for (const skill of skills) {
    if (tracked.skills.has(skill.id)) continue;
    const label = skillLabel(skill);
    resources.push({
      key: `skill-${skill.id}`,
      name: label.name,
      kind: 'skill',
      source: label.source,
      sourceDetail: skill.sourceRef,
      status: skill.status,
      href: `${base}/skills/${encodeURIComponent(skill.id)}`,
      updatedAt: skill.createdAt,
    });
  }
  for (const toolkit of toolkits) {
    if (tracked.toolkits.has(toolkit.id)) continue;
    resources.push({
      key: `toolkit-${toolkit.id}`,
      name: toolkit.name,
      kind: 'toolkit',
      source: 'workspace',
      status: toolkit.enabled ? 'enabled' : 'disabled',
      href: `${base}/toolkits/${encodeURIComponent(toolkit.slug)}`,
      updatedAt: toolkit.createdAt,
    });
  }
  for (const agent of agents) {
    if (tracked.agents.has(agent.id)) continue;
    resources.push({
      key: `agent-${agent.id}`,
      name: agent.name,
      kind: 'agent',
      source: 'workspace',
      sourceDetail: agent.runtimeKind,
      status: agent.runtime?.status ?? 'ready',
      href: `${base}/agents/${encodeURIComponent(agent.id)}`,
      updatedAt: agent.updatedAt,
    });
  }
  resources.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  const kindLabels: Record<ResourceKind, string> = {
    mcp: t('mcp'), skill: t('skills'), agent: t('agents'), assistant: t('kindAssistant'), toolkit: t('toolkits'), 'pi-package': t('kindPiPackage'),
  };
  const kindIcons = { mcp: Plug, skill: Brain, agent: Bot, assistant: MessageSquare, toolkit: Wrench, 'pi-package': Puzzle };
  const sourceLabels: Record<string, string> = {
    market: t('sourceMarket'), catalog: t('sourceCatalog'), workspace: t('sourceWorkspace'),
    github: t('sourceGithub'), upload: t('sourceUpload'), custom: t('sourceCustom'),
    config: t('sourceConfig'), docker: t('sourceDocker'),
  };
  const statusLabels: Record<string, string> = {
    ready: t('statusReady'), running: t('statusRunning'), published: t('statusPublished'),
    enabled: t('statusEnabled'), disabled: t('statusDisabled'), stopped: t('statusStopped'),
    provisioning: t('statusProvisioning'), installing: t('statusInstalling'),
    setup_required: t('statusSetupRequired'), modified: t('statusModified'),
    error: t('statusError'), failed: t('statusError'),
  };
  const updates = resources.filter((item) => item.market?.updateAvailable || item.copy?.updateAvailable).length;
  const error = Array.isArray(query.error) ? query.error[0] : query.error;
  const sdkAgents = agents.filter((agent) => agent.runtimeKind === 'pi-sdk');
  const errorLabels: Record<string, string> = {
    in_use: t('uninstallInUse'),
    package_platform_mismatch: t('piPlatformMismatch'),
    invalid_manifest: t('piInvalidManifest'),
    release_not_found: t('piUnavailable'),
    listing_not_found: t('piUnavailable'),
    listing_unavailable: t('piUnavailable'),
    install_not_found: t('piUnavailable'),
    release_not_approved: t('piUnavailable'),
    listing_conflict: t('publishErrorConflict'),
    not_authorized: t('publishErrorUnauthorized'),
  };

  return (
    <DashboardPage className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t('installedTitle')}</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            {t('installedDescription')}
          </p>
        </div>
        {updates > 0 ? (
          <AnimatedBadge status="warning" size="sm">
            <RotateCw className="size-3.5" />
            {t('updatesAvailable', { count: updates })}
          </AnimatedBadge>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorLabels[error] ?? t('uninstallFailed')}
        </p>
      ) : null}
      {!marketInstalls.some((install) => install.listing.kind === 'pi-package') ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground"><p>{t('piNoInstalls')}</p><ButtonLink href={`${base}/market/pi-packages`} variant="ghost" size="sm">{t('piPackages')}</ButtonLink></div>
      ) : null}

      {resources.length === 0 ? (
        <DashboardEmptyState
          icon={PackageCheck}
          title={t('installedEmptyTitle')}
          description={t('installedEmptyDescription')}
          actions={<ButtonLink href={`${base}/market/mcp`} variant="primary" size="md">{t('browseMcp')}</ButtonLink>}
        />
      ) : (
        <section aria-label={t('installedResources')} className="space-y-1">
          {resources.map((item) => {
            const Icon = kindIcons[item.kind];
            const version = item.market ?? item.copy;
            const latestIsNewer = Boolean(
              version?.latestReleaseId
              && (item.market
                ? item.market.latestReleaseId !== item.market.currentReleaseId
                : item.copy?.updateAvailable),
            );
            return (
              <article
                key={item.key}
                id={item.market ? `install-${item.market.installId}` : undefined}
                className="grid gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-muted/45 sm:grid-cols-[minmax(14rem,1.5fr)_8rem_9rem_minmax(10rem,1fr)_auto] sm:items-center"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <Link href={item.href} className="block truncate text-sm font-medium text-foreground hover:underline">
                      {item.name}
                    </Link>
                    {version ? (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {t(item.piPackage ? 'piWorkspaceVersion' : 'installedVersion', { version: version.currentVersion })}
                        {latestIsNewer && version.latestVersion
                          ? ` · ${t('latestVersion', { version: version.latestVersion })}`
                          : ''}
                      </p>
                    ) : null}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">{kindLabels[item.kind]}</span>
                <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <span className={`size-1.5 rounded-full ${statusTone(item.status)}`} />
                  {item.piPackage ? t(item.piPackage.available ? 'piInstalledOnly' : 'piUnavailable') : statusLabels[item.status] ?? item.status.replaceAll('_', ' ')}
                </span>
                <div className="min-w-0 text-xs text-muted-foreground">
                  <span className="block truncate">{sourceLabels[item.source] ?? item.source}</span>
                  {item.sourceDetail ? <span className="mt-0.5 block truncate opacity-75">{item.sourceDetail}</span> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  {item.market?.updateAvailable || item.copy?.updateAvailable ? (
                    <span className="text-xs font-medium text-(--color-warning) dark:text-(--color-warning)">{t('updateAvailable')}</span>
                  ) : item.market?.updateIgnored ? (
                    <span className="text-xs text-muted-foreground">{t('updateIgnored')}</span>
                  ) : null}
                  {latestIsNewer && item.market && item.status !== 'modified' ? (
                    <form action={updateMarketInstallAction}>
                      <input type="hidden" name="workspace" value={workspace.slug} />
                      <input type="hidden" name="installId" value={item.market.installId} />
                      {item.piPackage ? <input type="hidden" name="kind" value="pi-package" /> : null}
                      <input type="hidden" name="targetReleaseId" value={item.market.latestReleaseId ?? ''} />
                      <input type="hidden" name="currentReleaseId" value={item.market.currentReleaseId} />
                      <SubmitButton flash={false} pendingLabel={t('updating')} variant="primary" size="sm">
                        {t('update')}
                      </SubmitButton>
                    </form>
                  ) : null}
                  {item.copy?.updateAvailable ? (
                    <ButtonLink href={item.copy.updateHref} variant="primary" size="sm">
                      {t('createUpdatedCopy')}
                    </ButtonLink>
                  ) : null}
                  {item.market?.updateAvailable && item.status === 'modified' ? (
                    <ButtonLink href={item.market.detailHref} variant="secondary" size="sm">
                      {t('reviewUpdate')}
                    </ButtonLink>
                  ) : null}
                  {item.market?.updateAvailable ? (
                    <form action={ignoreMarketUpdateAction}>
                      <input type="hidden" name="workspace" value={workspace.slug} />
                      <input type="hidden" name="installId" value={item.market.installId} />
                      <input type="hidden" name="targetReleaseId" value={item.market.latestReleaseId ?? ''} />
                      <input type="hidden" name="currentReleaseId" value={item.market.currentReleaseId} />
                      <SubmitButton flash={false} pendingLabel={t('ignoringUpdate')} variant="ghost" size="sm">
                        {t('ignoreThisVersion')}
                      </SubmitButton>
                    </form>
                  ) : null}
                  <ButtonLink href={item.href} variant="ghost" size="sm">
                    {t('manage')} <ArrowUpRight className="size-3.5" />
                  </ButtonLink>
                  {item.market ? (
                    <form action={removeMarketInstallAction}>
                      <input type="hidden" name="workspace" value={workspace.slug} />
                      <input type="hidden" name="installId" value={item.market.installId} />
                      <ConfirmSubmitButton
                        triggerLabel={<><Trash2 className="size-3.5" />{t('uninstall')}</>}
                        triggerAriaLabel={`${t('uninstall')}: ${item.name}`}
                        prompt={t('uninstallConfirm', { name: item.name })}
                        confirmLabel={t('uninstall')}
                        pendingLabel={t('uninstalling')}
                        cancelLabel={common('cancel')}
                        
                        
                        
                        promptClassName="max-w-56 text-xs text-muted-foreground"
                      />
                    </form>
                  ) : null}
                  {item.copy?.agentId ? (
                    <form action={uninstallAgentMarketCopyAction}>
                      <input type="hidden" name="workspace" value={workspace.slug} />
                      <input type="hidden" name="agentId" value={item.copy.agentId} />
                      <input type="hidden" name="returnTo" value={`${base}/market/installed`} />
                      <ConfirmSubmitButton
                        triggerLabel={<><Trash2 className="size-3.5" />{t('uninstall')}</>}
                        triggerAriaLabel={`${t('uninstall')}: ${item.name}`}
                        prompt={t('uninstallConfirm', { name: item.name })}
                        confirmLabel={t('uninstall')}
                        pendingLabel={t('uninstalling')}
                        cancelLabel={common('cancel')}
                        
                        
                        
                        promptClassName="max-w-56 text-xs text-muted-foreground"
                      />
                    </form>
                  ) : null}
                  {item.copy?.assistantId ? (
                    <form action={removeAssistantMarketCopyAction}>
                      <input type="hidden" name="workspace" value={workspace.slug} />
                      <input type="hidden" name="assistantId" value={item.copy.assistantId} />
                      <ConfirmSubmitButton
                        triggerLabel={<><Trash2 className="size-3.5" />{t('uninstall')}</>}
                        triggerAriaLabel={`${t('uninstall')}: ${item.name}`}
                        prompt={t('uninstallConfirm', { name: item.name })}
                        confirmLabel={t('uninstall')}
                        pendingLabel={t('uninstalling')}
                        cancelLabel={common('cancel')}
                        
                        
                        
                        promptClassName="max-w-56 text-xs text-muted-foreground"
                      />
                    </form>
                  ) : null}
                </div>
                {item.piPackage ? (
                  <div className="space-y-3 text-xs text-muted-foreground sm:col-span-5">
                    <p>{t('piBindingHelp')}</p>
                    <p>{t(!item.piPackage.available ? 'piUnavailable' : item.piPackage.automaticReview ? 'piOfficialValidated' : 'piReviewApproved')}</p>
                    <p>{t('piExecutionWarning')}</p>
                    <p>{t('piHeadlessWarning')}</p>
                    <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer font-medium">{t('piSnapshotDetails')}</summary><div className="mt-3"><PiPackageDetails snapshot={item.piPackage.snapshot} checksum={item.piPackage.checksum} /></div></details>
                    {item.market ? <div className="space-y-2">
                      <ButtonLink href={`${base}/market/installed/${encodeURIComponent(item.market.installId)}/clients`} variant="secondary" size="sm">{t('piClients.manage')}</ButtonLink>
                      <ButtonLink href={`${base}/market/installed/${encodeURIComponent(item.market.installId)}/clients#workspace-bindings`} variant="ghost" size="sm">{t('piClients.workspaceBindingsTitle')}</ButtonLink>
                      {item.piPackage.available ? <ButtonLink href={`/api/v1/workspaces/${encodeURIComponent(workspace.slug)}/market/pi-packages/${encodeURIComponent(item.market.currentReleaseId)}/download`} variant="ghost" size="sm">{t('piArtifactDownload')}</ButtonLink> : null}
                      <p>{t('piClients.pinnedHelp')}</p>
                      {clientInstallations.filter((client) => client.marketInstallId === item.market?.installId).map((client) => <p key={client.id} className="break-all">{client.label} · {client.client} · {t(client.status === 'active' ? 'piClients.active' : 'piClients.revoked')} · {client.releaseId}</p>)}
                    </div> : null}
                    {item.piPackage.bindings.length ? (
                      <div className="space-y-2">
                        <h3 className="font-semibold text-foreground">{t('piAgentVersions')}</h3>
                        {item.piPackage.bindings.map((binding) => (
                          <div key={binding.agentId} className="space-y-1">
                            <ButtonLink href={`${base}/agents/${encodeURIComponent(binding.agentId)}?settings=piPackages`} variant="ghost" size="sm">{binding.name} · {t('versionLabel', { version: binding.version })}</ButtonLink>
                            <p>{t(binding.reviewStatus === 'approved' ? 'piReviewApproved' : 'piUnavailable')}{binding.releaseId !== item.market?.currentReleaseId ? ` · ${t('piOlderAgentVersion')}` : ''}</p>
                            <p className="break-all font-mono">SHA-256 {binding.checksum}</p>
                          </div>
                        ))}
                        <p>{t('piUnbindBeforeUninstall')}</p>
                      </div>
                    ) : <p>{t('piNotBound')}</p>}
                    <div className="flex flex-wrap items-center gap-2">
                      <ButtonLink href={`${base}/agents?create=1&runtime=pi-sdk`} variant="secondary" size="sm">{t('piCreateAgent')}</ButtonLink>
                      {sdkAgents.map((agent) => <ButtonLink key={agent.id} href={`${base}/agents/${encodeURIComponent(agent.id)}?settings=piPackages`} variant="ghost" size="sm">{t('piConfigureAgent', { name: agent.name })}</ButtonLink>)}
                    </div>
                    {sdkAgents.length === 0 ? <p>{t('piNoAgents')}</p> : null}
                  </div>
                ) : null}
                {(item.market?.updateAvailable && item.market.releaseNotes) || (item.copy?.updateAvailable && item.copy.releaseNotes) ? (
                  <p className="text-xs leading-5 text-muted-foreground sm:col-start-2 sm:col-end-6">
                    {item.market?.releaseNotes ?? item.copy?.releaseNotes}
                  </p>
                ) : null}
                {item.copy?.updateAvailable ? (
                  <p className="text-xs leading-5 text-muted-foreground sm:col-start-2 sm:col-end-6">
                    {t('copyUpdateSafety')}
                  </p>
                ) : null}
              </article>
            );
          })}
        </section>
      )}
    </DashboardPage>
  );
}
