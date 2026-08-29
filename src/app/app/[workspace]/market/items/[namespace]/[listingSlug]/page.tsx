import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  ArrowRight,
  Box,
  Brain,
  CheckCircle2,
  ExternalLink,
  FileArchive,
  GitBranch,
  MessageCircle,
  PackageCheck,
  Plug,
  RotateCw,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { db } from '@/lib/db';
import {
  ignoreMarketUpdateAction,
  installMarketResourceAction,
  updateMarketInstallAction,
} from '@/lib/market/actions';
import { parseAssistantReleaseManifest } from '@/lib/market/assistant-manifest';
import { getMarketListing } from '@/lib/market/listings';
import { parseSkillReleaseManifest } from '@/lib/market/skill-manifest';
import {
  parseMcpMarketManifest,
  parseToolkitMarketManifest,
} from '@/lib/market/resources';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { listSandboxes } from '@/lib/sandboxes/queries';
import { readMcpInspectorConnection } from '@/lib/workspace/inspector-connection';
import { effectiveStatus } from '@/lib/process/supervisor';
import {
  hasMcpToolCatalog,
  hasVerifiedMcpToolCatalog,
  readMcpToolCatalog,
} from '@/lib/process/mcp-tool-catalog';
import { DashboardPage } from '@/components/dashboard/DashboardUI';
import {
  MarketDetailHeader,
  MarketDetailShell,
} from '@/components/dashboard/market/MarketDetailShell';
import { SkillMarkdownViewer } from '@/components/dashboard/SkillMarkdownViewer';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { McpToolCatalog } from '@/components/dashboard/McpToolCatalog';
import { SafeStreamdown } from '@/components/dashboard/SafeStreamdown';
import { ToolPlayground } from '@/components/dashboard/ToolPlayground';

export const dynamic = 'force-dynamic';

function endpointHost(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      ? url.hostname
      : null;
  } catch {
    return null;
  }
}

export default async function MarketItemPage({
  params,
}: {
  params: Promise<{ workspace: string; namespace: string; listingSlug: string }>;
}) {
  const [{ workspace: workspaceSlug, namespace, listingSlug }, t, mcpT, locale, user] = await Promise.all([
    params,
    getTranslations('console.market'),
    getTranslations('console.mcp'),
    getLocale(),
    getCurrentUser(),
  ]);
  const currentPath = `/app/${workspaceSlug}/market/items/${namespace}/${listingSlug}`;
  if (!user) redirect(`/app/login?next=${encodeURIComponent(currentPath)}`);
  const workspace = await getWorkspaceForUser(workspaceSlug, user.id);
  if (!workspace) redirect('/app');
  const listing = await getMarketListing(namespace, listingSlug);
  if (!listing?.latestRelease || !['skill', 'assistant', 'mcp', 'toolkit'].includes(listing.kind)) notFound();

  const skillManifest = listing.kind === 'skill'
    ? parseSkillReleaseManifest(listing.latestRelease.manifest, listing.latestRelease.checksum)
    : null;
  const assistantManifest = listing.kind === 'assistant'
    ? parseAssistantReleaseManifest(listing.latestRelease.manifest, listing.latestRelease.checksum).assistant
    : null;
  const mcpManifest = listing.kind === 'mcp'
    ? parseMcpMarketManifest(listing.latestRelease.manifest, listing.latestRelease.checksum)
    : null;
  const connector = mcpManifest?.mcp.recipe.source === 'remote'
    ? {
        endpointHost: endpointHost(mcpManifest.mcp.recipe.ref),
        transport: mcpManifest.mcp.recipe.transport ?? 'streamable-http',
        authType: mcpManifest.mcp.recipe.authType ?? 'none',
      }
    : null;
  const toolkitManifest = listing.kind === 'toolkit'
    ? parseToolkitMarketManifest(listing.latestRelease.manifest, listing.latestRelease.checksum)
    : null;

  const install = listing.kind !== 'assistant' ? await db.marketInstall.findUnique({
    where: {
      targetWorkspaceId_listingId: {
        targetWorkspaceId: workspace.id,
        listingId: listing.id,
      },
    },
    include: {
      currentRelease: { select: { version: true } },
      installedSkill: { select: { id: true, workspaceId: true } },
      deployment: { select: { id: true, workspaceId: true, status: true, installCfg: true } },
      toolkit: { select: { id: true, slug: true, workspaceId: true } },
    },
  }) : null;
  const installedSkill = install?.installedSkill?.workspaceId === workspace.id ? install.installedSkill : null;
  const installedDeployment = install?.deployment?.workspaceId === workspace.id ? install.deployment : null;
  const installedToolkit = install?.toolkit?.workspaceId === workspace.id ? install.toolkit : null;
  const updateAvailable = Boolean(install && install.currentReleaseId !== listing.latestRelease.id);
  const downloadHref = `/api/v1/market/listings/${encodeURIComponent(namespace)}/${encodeURIComponent(listingSlug)}/download`;
  const marketSection = listing.kind === 'assistant' ? 'assistants'
    : listing.kind === 'skill' ? 'skills'
      : listing.kind === 'mcp' ? 'mcp'
        : 'toolkits';
  const marketBase = `/app/${encodeURIComponent(workspaceSlug)}/market/${marketSection}`;
  const marketBackHref = `${marketBase}${connector ? '?type=connector' : ''}`;
  const publishedAt = listing.latestRelease.publishedAt ?? listing.publishedAt;
  const formattedDate = publishedAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(publishedAt)
    : t('notSpecified');
  const resourceType = listing.kind === 'assistant' ? t('kindAssistant')
    : listing.kind === 'skill' ? t('kindSkill')
      : listing.kind === 'mcp' ? t(connector ? 'kindMcpConnector' : 'kindMcp')
        : t('kindToolkit');
  const installedMcpDeployment = mcpManifest ? installedDeployment : null;
  const catalogServer = mcpManifest && !connector ? (await db.marketListing.findUnique({
    where: { id: listing.id },
    select: {
      sourceServer: { select: { installCfg: true, verifiedAt: true, verifiedTools: true } },
    },
  }))?.sourceServer : null;
  const serverToolsVisible = hasVerifiedMcpToolCatalog(catalogServer);
  const inspectorConnection = connector
    ? readMcpInspectorConnection(installedMcpDeployment?.installCfg)
    : null;
  const inspectorSandbox = inspectorConnection ? await db.sandbox.findFirst({
    where: { id: inspectorConnection.sandboxId, workspaceId: workspace.id },
    select: { deployment: { select: { id: true, status: true } } },
  }) : null;
  const inspectorRunning = Boolean(
    inspectorSandbox
    && effectiveStatus(inspectorSandbox.deployment.id, inspectorSandbox.deployment.status) === 'running',
  );
  const mcpTools = connector
    ? inspectorRunning && installedMcpDeployment && hasMcpToolCatalog(installedMcpDeployment.installCfg)
      ? readMcpToolCatalog(installedMcpDeployment.installCfg)
      : []
    : serverToolsVisible ? readMcpToolCatalog(catalogServer?.installCfg) : [];
  const toolsVisible = serverToolsVisible || inspectorRunning;
  const inspectorSandboxes = connector && installedMcpDeployment
    ? (await listSandboxes(workspace.id))
      .filter((sandbox) => sandbox.kind === 'docker' || sandbox.kind === 'connector')
      .map((sandbox) => ({
        id: sandbox.id,
        name: sandbox.name,
        kind: sandbox.kind,
        running: effectiveStatus(sandbox.deploymentId, sandbox.deployment.status) === 'running',
        networkEnabled: sandbox.network !== 'none',
      }))
    : [];

  const skillInstallPanel = skillManifest ? (
    <>
      <section className="rounded-lg bg-muted/35 p-5">
        <div className="flex items-start gap-2.5">
          {install ? (
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
          ) : (
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-foreground" />
          )}
          <div>
            <p className="text-sm font-semibold text-foreground">
              {install ? t('alreadyAddedTitle') : t('readyToDeploy')}
            </p>
            {install ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('installedVersion', { version: install.currentRelease.version })}
              </p>
            ) : null}
          </div>
        </div>
        {!install ? (
          <form action={installMarketResourceAction} className="mt-5">
            <input type="hidden" name="workspace" value={workspaceSlug} />
            <input type="hidden" name="releaseId" value={listing.latestRelease.id} />
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <SubmitButton flash={false} pendingLabel={t('installing')} className="ui-button-primary h-10 w-full">
              {t('installToWorkspace')} <ArrowRight className="size-4" />
            </SubmitButton>
          </form>
        ) : updateAvailable ? (
          <div className="mt-5 space-y-2">
            <form action={updateMarketInstallAction}>
              <input type="hidden" name="workspace" value={workspaceSlug} />
              <input type="hidden" name="installId" value={install.id} />
              <input type="hidden" name="targetReleaseId" value={listing.latestRelease.id} />
              <input type="hidden" name="currentReleaseId" value={install.currentReleaseId} />
              {install.status === 'modified' ? (
                <label className="mb-3 flex items-start gap-2 rounded-md bg-amber-500/10 p-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
                  <input required type="checkbox" name="force" value="yes" className="mt-1 size-3.5 shrink-0 accent-amber-600" />
                  <span>{t('overwriteLocalChangesConfirmation')}</span>
                </label>
              ) : null}
              <SubmitButton flash={false} pendingLabel={t('updating')} className="ui-button-primary h-10 w-full">
                <RotateCw className="size-4" /> {t('update')}
              </SubmitButton>
            </form>
            <form action={ignoreMarketUpdateAction}>
              <input type="hidden" name="workspace" value={workspaceSlug} />
              <input type="hidden" name="installId" value={install.id} />
              <input type="hidden" name="targetReleaseId" value={listing.latestRelease.id} />
              <input type="hidden" name="currentReleaseId" value={install.currentReleaseId} />
              <SubmitButton flash={false} pendingLabel={t('ignoringUpdate')} className="ui-button-secondary h-10 w-full">
                {t('ignoreThisVersion')}
              </SubmitButton>
            </form>
          </div>
        ) : installedSkill ? (
          <Link href={`/app/${workspaceSlug}/skills/${installedSkill.id}`} className="ui-button-primary mt-5 h-10 w-full">
            {t('manageSkill')} <ArrowRight className="size-4" />
          </Link>
        ) : null}
      </section>
      <dl id="capabilities" className="scroll-mt-24 space-y-3 text-xs">
        <div className="flex items-center justify-between gap-4">
          <dt className="inline-flex items-center gap-1.5 text-muted-foreground"><GitBranch className="size-3.5" />{t('source')}</dt>
          <dd className="truncate font-medium text-foreground">{skillManifest.skill.source.type}</dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="inline-flex items-center gap-1.5 text-muted-foreground"><FileArchive className="size-3.5" />{t('bundledFiles', { count: skillManifest.skill.files.length })}</dt>
          <dd className="font-medium text-foreground">{skillManifest.skill.files.length}</dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-muted-foreground">SHA-256</dt>
          <dd className="font-mono text-foreground" title={listing.latestRelease.checksum}>
            {listing.latestRelease.checksum.slice(0, 12)}
          </dd>
        </div>
      </dl>
    </>
  ) : null;

  const assistantPanel = assistantManifest ? (
    <>
      <section className="rounded-lg bg-muted/35 p-5">
        <MessageCircle className="size-5 text-foreground" />
        <h2 className="mt-3 text-base font-semibold text-foreground">{t('useAssistantTemplate')}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('useAssistantTemplateDescription')}</p>
        <Link
          href={`/app/${encodeURIComponent(workspaceSlug)}/chat?newAssistant=1&template=${encodeURIComponent(listing.latestRelease.id)}`}
          className="ui-button-primary mt-5 h-10 w-full"
        >
          {t('createFromTemplate')} <ArrowRight className="size-4" />
        </Link>
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">{t('configurationSummary')}</h2>
        <dl className="space-y-3 text-xs">
          {[
            [t('model'), assistantManifest.modelRequirement?.model ?? t('notSpecified')],
            [t('providerFormat'), assistantManifest.modelRequirement?.providerFormat ?? t('notSpecified')],
            [t('maximumSteps'), String(assistantManifest.maxSteps)],
            [t('mcp'), String(assistantManifest.mcpRequirements.length)],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="max-w-44 truncate text-right font-medium text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  ) : null;

  const installedResourceHref = installedDeployment
    ? `/app/${encodeURIComponent(workspaceSlug)}/mcp/${encodeURIComponent(installedDeployment.id)}${
        installedDeployment.status === 'setup_required' ? '?tab=variables' : ''
      }`
    : installedToolkit
      ? `/app/${encodeURIComponent(workspaceSlug)}/toolkits/${encodeURIComponent(installedToolkit.slug)}`
      : null;
  const resourceCanInstall = Boolean(connector || toolkitManifest);
  const resourceInstallPanel = mcpManifest || toolkitManifest ? (
    <>
      {resourceCanInstall ? <section className="rounded-lg bg-muted/35 p-5">
        <div className="flex items-start gap-2.5">
          {install ? (
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
          ) : (
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-foreground" />
          )}
          <div>
            <p className="text-sm font-semibold text-foreground">
              {install ? t('alreadyAddedTitle') : t(connector ? 'readyToConnect' : 'readyToDeploy')}
            </p>
            {install ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('installedVersion', { version: install.currentRelease.version })}
              </p>
            ) : null}
          </div>
        </div>
        {!install ? (
          <form action={installMarketResourceAction} className="mt-5">
            <input type="hidden" name="workspace" value={workspaceSlug} />
            <input type="hidden" name="releaseId" value={listing.latestRelease.id} />
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <SubmitButton flash={false} pendingLabel={t(connector ? 'connecting' : 'installing')} className="ui-button-primary h-10 w-full">
              {t(connector ? 'connectToWorkspace' : 'installToWorkspace')} <ArrowRight className="size-4" />
            </SubmitButton>
          </form>
        ) : updateAvailable ? (
          <div className="mt-5 space-y-2">
            <form action={updateMarketInstallAction}>
              <input type="hidden" name="workspace" value={workspaceSlug} />
              <input type="hidden" name="installId" value={install.id} />
              <input type="hidden" name="targetReleaseId" value={listing.latestRelease.id} />
              <input type="hidden" name="currentReleaseId" value={install.currentReleaseId} />
              <SubmitButton flash={false} pendingLabel={t('updating')} className="ui-button-primary h-10 w-full">
                <RotateCw className="size-4" /> {t('update')}
              </SubmitButton>
            </form>
            <form action={ignoreMarketUpdateAction}>
              <input type="hidden" name="workspace" value={workspaceSlug} />
              <input type="hidden" name="installId" value={install.id} />
              <input type="hidden" name="targetReleaseId" value={listing.latestRelease.id} />
              <input type="hidden" name="currentReleaseId" value={install.currentReleaseId} />
              <SubmitButton flash={false} pendingLabel={t('ignoringUpdate')} className="ui-button-secondary h-10 w-full">
                {t('ignoreThisVersion')}
              </SubmitButton>
            </form>
          </div>
        ) : installedResourceHref ? (
          <Link href={installedResourceHref} className="ui-button-primary mt-5 h-10 w-full">
            {t('manage')} <ArrowRight className="size-4" />
          </Link>
        ) : null}
      </section> : null}
      <dl id="capabilities" className="scroll-mt-24 space-y-3 text-xs">
        {mcpManifest ? (
          <>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">{t('source')}</dt>
              <dd className="font-medium text-foreground">
                {mcpManifest.mcp.recipe.sourceUrl ? (
                  <a
                    href={mcpManifest.mcp.recipe.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 hover:underline"
                  >
                    {mcpManifest.mcp.recipe.source} <ExternalLink className="size-3" />
                  </a>
                ) : mcpManifest.mcp.recipe.source}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">{t('requiredEnvironment')}</dt>
              <dd className="font-medium text-foreground">{mcpManifest.mcp.recipe.env.length}</dd>
            </div>
            {toolsVisible ? (
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">{t('tools')}</dt>
                <dd className="font-medium text-foreground">{mcpTools.length}</dd>
              </div>
            ) : null}
          </>
        ) : toolkitManifest ? (
          <>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">{t('mcp')}</dt>
              <dd className="font-medium text-foreground">{toolkitManifest.mcps.length}</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">{t('skills')}</dt>
              <dd className="font-medium text-foreground">{toolkitManifest.skills.length}</dd>
            </div>
          </>
        ) : null}
      </dl>
    </>
  ) : null;

  return (
    <DashboardPage className="space-y-7">
      <MarketDetailHeader
        backHref={marketBackHref}
        backLabel={listing.kind === 'assistant' ? t('backToAssistants')
          : listing.kind === 'skill' ? t('backToSkills')
            : listing.kind === 'mcp' ? t('backToMcp')
              : t('toolkits')}
        iconUrl={listing.iconUrl}
        icon={listing.kind === 'assistant' ? <MessageCircle className="size-7" />
          : listing.kind === 'skill' ? <Brain className="size-7" />
            : listing.kind === 'mcp' ? <Box className="size-7" />
              : <Wrench className="size-7" />}
        type={resourceType}
        title={listing.name}
        publisher={t('publishedBy', { name: namespace })}
        summary={listing.summary || skillManifest?.skill.description || mcpManifest?.mcp.description || t('noDescription')}
        facts={[
          { label: t('version'), value: `v${listing.latestRelease.version}` },
          { label: t('usageCount'), value: listing.installCount },
          { label: t('lastUpdated'), value: <time dateTime={publishedAt?.toISOString()}>{formattedDate}</time> },
          ...(connector ? [
            { label: t('connectorEndpoint'), value: connector.endpointHost ?? t('notSpecified') },
            {
              label: t('connectorTransport'),
              value: t(connector.transport === 'sse' ? 'transportSse' : 'transportStreamableHttp'),
            },
            {
              label: t('connectorAuthentication'),
              value: t(connector.authType === 'bearer'
                ? 'authBearer'
                : connector.authType === 'headers'
                  ? 'authHeaders'
                  : 'authNone'),
            },
          ] : []),
        ]}
        tags={[
          ...listing.categories.map((category) => ({
            label: category.name,
            href: `${marketBase}?${connector ? 'type=connector&' : ''}category=${encodeURIComponent(category.slug)}`,
          })),
          ...listing.tags
            .filter((tag) => !listing.categories.some((category) => category.slug === tag))
            .map((tag) => ({ label: tag })),
        ]}
      />

      <MarketDetailShell
        navigationLabel={t('detailNavigation')}
        tabs={[
          { href: '#overview', label: t('overview') },
          { href: '#capabilities', label: t('capabilities') },
          ...(toolsVisible ? [{ href: '#tools', label: t('tools') }] : []),
          ...(connector && installedMcpDeployment ? [{ href: '#inspector', label: t('inspector') }] : []),
        ]}
        aside={skillInstallPanel ?? assistantPanel ?? resourceInstallPanel}
      >
        {skillManifest ? (
          <section id="overview" className="scroll-mt-24">
            <SkillMarkdownViewer markdown={skillManifest.skill.content} downloadHref={downloadHref} />
          </section>
        ) : assistantManifest ? (
          <>
            <section id="overview" className="scroll-mt-24">
              <div className="flex items-center gap-2.5">
                <MessageCircle className="size-[18px] text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('assistantInstructions')}</h2>
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('assistantInstructionsDescription')}</p>
              {assistantManifest.systemPrompt ? (
                <pre className="mt-4 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md bg-muted/55 p-4 font-mono text-xs leading-6 text-foreground">
                  {assistantManifest.systemPrompt}
                </pre>
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">{t('noAssistantInstructions')}</p>
              )}
            </section>
            <section id="capabilities" className="scroll-mt-24">
              <div className="flex items-center gap-2.5">
                <PackageCheck className="size-[18px] text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('assistantCapabilities')}</h2>
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('assistantCapabilitiesDescription')}</p>
              {assistantManifest.mcpRequirements.length ? (
                <div className="mt-4 divide-y divide-border/60 border-y border-border/60">
                  {assistantManifest.mcpRequirements.map((mcp) => (
                    <div key={`${mcp.catalogSlug}:${mcp.name}`} className="flex items-center justify-between gap-4 py-3.5">
                      <span className="text-sm font-medium text-foreground">{mcp.name}</span>
                      <span className="truncate text-xs text-muted-foreground">{mcp.catalogSlug ?? t('notSpecified')}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">{t('noAssistantCapabilities')}</p>
              )}
            </section>
          </>
        ) : mcpManifest ? (
          <>
            <section id="overview" className="scroll-mt-24">
              <div className="flex items-center gap-2.5">
                <Plug className="size-[18px] text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('about')}</h2>
              </div>
              <div className="prose prose-sm mt-4 max-w-none leading-7 dark:prose-invert">
                <SafeStreamdown mode="static" linkSafety={{ enabled: true }}>
                  {mcpManifest.mcp.readme || mcpManifest.mcp.description || t('noDescription')}
                </SafeStreamdown>
              </div>
            </section>
            <section id="capabilities" className="scroll-mt-24 space-y-4">
              <h2 className="font-semibold text-foreground">
                {t(connector ? 'connectorConfiguration' : 'deploymentRecipe')}
              </h2>
              <code className="block break-all rounded-md bg-muted/35 px-3 py-2 text-xs text-foreground">
                {connector?.endpointHost ?? mcpManifest.mcp.recipe.ref}
              </code>
              {mcpManifest.mcp.recipe.env.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {mcpManifest.mcp.recipe.env.map((name) => (
                    <code key={name} className="rounded-md bg-muted px-2 py-1 text-xs text-foreground">{name}</code>
                  ))}
                </div>
              ) : null}
            </section>
            {toolsVisible ? <div id="tools" className="scroll-mt-24">
              {mcpTools.length ? (
                <McpToolCatalog
                  tools={mcpTools}
                  compact={Boolean(connector)}
                  hrefForTool={(toolName) => (
                    `/app/${encodeURIComponent(workspaceSlug)}/market/items/${encodeURIComponent(namespace)}/${encodeURIComponent(listingSlug)}/tools/${encodeURIComponent(toolName)}`
                  )}
                  labels={{
                    title: mcpT('toolCatalog'),
                    description: mcpT('toolCatalogDescription'),
                    count: mcpT('toolsCount', { count: mcpTools.length }),
                    instructions: mcpT('instructions'),
                    inputSchema: mcpT('inputSchema'),
                    schemaJson: mcpT('schemaJson'),
                    parameter: mcpT('parameter'),
                    type: mcpT('type'),
                    descriptionColumn: mcpT('descriptionColumn'),
                    required: mcpT('required'),
                    defaultValue: mcpT('defaultValue'),
                    noDescription: mcpT('noDescription'),
                    noArguments: mcpT('noArguments'),
                  }}
                />
              ) : (
                <section className="rounded-lg bg-muted/35 p-5">
                  <h2 className="text-sm font-semibold text-foreground">{mcpT('toolCatalog')}</h2>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {connector ? t('deployToInspectTools') : mcpT('noToolsAvailable')}
                  </p>
                </section>
              )}
            </div> : null}
            {connector && installedMcpDeployment ? (
              <section id="inspector" className="ui-panel scroll-mt-24 overflow-hidden">
                <header className="border-b border-border px-5 py-4">
                  <h2 className="text-sm font-semibold text-foreground">{t('inspector')}</h2>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('inspectorDescription')}</p>
                </header>
                <div className="px-5 py-5">
                  <ToolPlayground
                    workspace={workspaceSlug}
                    deploymentId={installedMcpDeployment.id}
                    tools={mcpTools}
                    sandboxes={inspectorSandboxes}
                    connectedSandboxId={inspectorConnection?.sandboxId}
                    credentialsRequired={installedMcpDeployment.status === 'setup_required'}
                  />
                </div>
              </section>
            ) : null}
          </>
        ) : toolkitManifest ? (
          <section id="overview" className="scroll-mt-24 space-y-6">
            <div>
              <div className="flex items-center gap-2.5">
                <Plug className="size-[18px] text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('mcp')}</h2>
              </div>
              <div className="mt-3 divide-y divide-border/60 border-y border-border/60">
                {toolkitManifest.mcps.map((mcp) => (
                  <div key={mcp.catalogSlug} className="flex items-center justify-between gap-4 py-3 text-sm">
                    <span className="font-medium text-foreground">{mcp.name}</span>
                    <code className="truncate text-xs text-muted-foreground">{mcp.catalogSlug}</code>
                  </div>
                ))}
              </div>
            </div>
            <div id="capabilities" className="scroll-mt-24">
              <div className="flex items-center gap-2.5">
                <Brain className="size-[18px] text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('skills')}</h2>
              </div>
              <div className="mt-3 divide-y divide-border/60 border-y border-border/60">
                {toolkitManifest.skills.map((skill) => (
                  <div key={skill.snapshot.slug} className="py-3 text-sm font-medium text-foreground">
                    {skill.snapshot.name}
                  </div>
                ))}
              </div>
            </div>
          </section>
        ) : null}
      </MarketDetailShell>
    </DashboardPage>
  );
}
