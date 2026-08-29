import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Brain, ExternalLink, MessageSquare, Plug, Wrench } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { McpToolCatalog } from '@/components/dashboard/McpToolCatalog';
import { db } from '@/lib/db';
import { getMarketListing } from '@/lib/market/listings';
import { parseAssistantReleaseManifest } from '@/lib/market/assistant-manifest';
import { parseSkillReleaseManifest } from '@/lib/market/skill-manifest';
import { parseMcpMarketManifest, parseToolkitMarketManifest } from '@/lib/market/resources';
import {
  hasVerifiedMcpToolCatalog,
  readMcpToolCatalog,
  type McpToolDefinition,
} from '@/lib/process/mcp-tool-catalog';
import { SITE } from '@/lib/site';
import { siteMetadata } from '../../../_lib/metadata';

const MARKET_PATHS = {
  mcp: 'mcp',
  skill: 'skills',
  assistant: 'assistants',
  toolkit: 'toolkits',
} as const;

async function listing(namespace: string, slug: string) {
  try {
    const result = await getMarketListing(namespace, slug);
    return result && result.kind in MARKET_PATHS ? result : null;
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ namespace: string; slug: string }>;
}): Promise<Metadata> {
  const { namespace, slug } = await params;
  const result = await listing(namespace, slug);
  const path = `/market/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`;
  return result
    ? siteMetadata({ title: `${result.name} | ${SITE.name}`, description: result.summary ?? `${result.name} on ${SITE.name}.`, path })
    : siteMetadata({ title: `Page not found | ${SITE.name}`, description: `${SITE.name} marketplace resource.`, path, index: false });
}

export default async function PublicMarketDetailPage({
  params,
}: {
  params: Promise<{ namespace: string; slug: string }>;
}) {
  const [{ namespace, slug }, t, categoriesT, mcpT] = await Promise.all([
    params,
    getTranslations('console.market'),
    getTranslations('categories'),
    getTranslations('console.mcp'),
  ]);
  const result = await listing(namespace, slug);
  if (!result?.latestRelease || !(result.kind in MARKET_PATHS)) notFound();

  const kind = result.kind as keyof typeof MARKET_PATHS;
  const mcpManifest = kind === 'mcp'
    ? parseMcpMarketManifest(result.latestRelease.manifest, result.latestRelease.checksum)
    : null;
  const connector = mcpManifest?.mcp.recipe.source === 'remote';
  const sourceServer = mcpManifest && !connector ? (await db.marketListing.findUnique({
    where: { id: result.id },
    select: {
      sourceServer: { select: { installCfg: true, verifiedAt: true, verifiedTools: true } },
    },
  }))?.sourceServer : null;
  const serverTools = hasVerifiedMcpToolCatalog(sourceServer)
    ? readMcpToolCatalog(sourceServer?.installCfg)
    : [];
  const kindLabel = t(kind === 'mcp'
    ? connector ? 'kindMcpConnector' : 'kindMcp'
    : kind === 'skill'
      ? 'kindSkill'
      : kind === 'assistant'
        ? 'kindAssistant'
        : 'kindToolkit');
  const Icon = kind === 'mcp' ? Plug : kind === 'skill' ? Brain : kind === 'assistant' ? MessageSquare : Wrench;
  const workspaceHref = `/app?market=${MARKET_PATHS[kind]}&q=${encodeURIComponent(result.name)}`;

  return (
    <article className="mx-auto max-w-5xl px-4 py-12">
      <Link href="/categories" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {categoriesT('categories')}
      </Link>
      <header className="mt-7 border-b border-border pb-8">
        <div className="flex items-start gap-4">
          {result.iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={result.iconUrl} alt="" width={64} height={64} className="size-16 rounded-lg object-cover" />
          ) : (
            <span className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Icon className="size-7" aria-hidden="true" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-brand">{kindLabel} · {t('versionLabel', { version: result.latestRelease.version })}</p>
            <h1 className="mt-2 text-3xl font-semibold text-foreground sm:text-4xl">{result.name}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{t('publishedBy', { name: result.namespace })}</p>
            <p className="mt-5 max-w-3xl text-base leading-7 text-muted-foreground">{result.summary ?? t('noDescription')}</p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          {result.categories.map((category) => (
            <Link key={category.slug} href={`/categories/${encodeURIComponent(category.slug)}`} className="ui-chip">
              {category.name}
            </Link>
          ))}
        </div>
      </header>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-10">
          {kind === 'skill' ? <SkillDetail manifest={result.latestRelease.manifest} checksum={result.latestRelease.checksum} t={t} /> : null}
          {kind === 'assistant' ? <AssistantDetail manifest={result.latestRelease.manifest} checksum={result.latestRelease.checksum} t={t} /> : null}
          {mcpManifest ? <McpDetail mcp={mcpManifest.mcp} tools={serverTools} t={t} mcpT={mcpT} /> : null}
          {kind === 'toolkit' ? <ToolkitDetail manifest={result.latestRelease.manifest} checksum={result.latestRelease.checksum} t={t} /> : null}
        </div>
        {kind !== 'mcp' || connector ? <aside>
          <div className="sticky top-20 bg-muted/35 p-5">
            <h2 className="font-semibold text-foreground">{t(connector ? 'readyToConnect' : 'installToWorkspace')}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{t(connector ? 'connectorRedirectHint' : 'privateByDefault')}</p>
            <Link href={workspaceHref} className="ui-button-primary mt-5 h-10 w-full">
              {t(connector ? 'connectToWorkspace' : 'addToWorkspace')}
            </Link>
          </div>
        </aside> : null}
      </div>
    </article>
  );
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

function SkillDetail({ manifest, checksum, t }: { manifest: unknown; checksum: string; t: Translate }) {
  const skill = parseSkillReleaseManifest(manifest, checksum).skill;
  return (
    <section>
      <h2 className="text-lg font-semibold text-foreground">{t('kindSkill')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('skillContentDescription')}</p>
      <pre className="mt-4 max-h-[48rem] overflow-auto whitespace-pre-wrap break-words bg-muted/35 p-5 font-mono text-sm leading-7 text-foreground">{skill.content}</pre>
      {skill.files.length ? <p className="mt-3 text-sm text-muted-foreground">{t('bundledFiles', { count: skill.files.length })}</p> : null}
    </section>
  );
}

function AssistantDetail({ manifest, checksum, t }: { manifest: unknown; checksum: string; t: Translate }) {
  const assistant = parseAssistantReleaseManifest(manifest, checksum).assistant;
  return (
    <>
      <section>
        <h2 className="text-lg font-semibold text-foreground">{t('assistantInstructions')}</h2>
        <pre className="mt-4 whitespace-pre-wrap break-words bg-muted/35 p-5 text-sm leading-7 text-foreground">{assistant.systemPrompt || t('noAssistantInstructions')}</pre>
      </section>
      <section>
        <h2 className="text-lg font-semibold text-foreground">{t('configurationSummary')}</h2>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
          <div><dt className="text-muted-foreground">{t('model')}</dt><dd className="mt-1 font-medium">{assistant.modelRequirement?.model ?? t('notSpecified')}</dd></div>
          <div><dt className="text-muted-foreground">{t('providerFormat')}</dt><dd className="mt-1 font-medium">{assistant.modelRequirement?.providerFormat ?? t('notSpecified')}</dd></div>
          <div><dt className="text-muted-foreground">{t('maximumSteps')}</dt><dd className="mt-1 font-medium">{assistant.maxSteps}</dd></div>
        </dl>
        {assistant.mcpRequirements.length ? (
          <ul className="mt-5 space-y-2 text-sm">{assistant.mcpRequirements.map((mcp) => <li key={mcp.catalogSlug}>{mcp.name} <code className="text-muted-foreground">{mcp.catalogSlug}</code></li>)}</ul>
        ) : null}
      </section>
    </>
  );
}

function McpDetail({ mcp, tools, t, mcpT }: {
  mcp: ReturnType<typeof parseMcpMarketManifest>['mcp'];
  tools: McpToolDefinition[];
  t: Translate;
  mcpT: Translate;
}) {
  const connector = mcp.recipe.source === 'remote';
  return (
    <>
      <section><h2 className="text-lg font-semibold text-foreground">{t('about')}</h2><p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{mcp.readme ?? mcp.description ?? t('noDescription')}</p></section>
      <section>
        <h2 className="text-lg font-semibold text-foreground">{t(connector ? 'connectorConfiguration' : 'deploymentRecipe')}</h2>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{t('source')}</dt>
            <dd className="mt-1 font-medium">
              {mcp.recipe.sourceUrl ? (
                <a
                  href={mcp.recipe.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:underline"
                >
                  {mcp.recipe.source} <ExternalLink className="size-3.5" />
                </a>
              ) : mcp.recipe.source}
            </dd>
          </div>
          {connector ? (
            <>
              <div><dt className="text-muted-foreground">{t('connectorEndpoint')}</dt><dd className="mt-1 break-all font-mono text-xs">{mcp.recipe.ref}</dd></div>
              <div><dt className="text-muted-foreground">{t('connectorTransport')}</dt><dd className="mt-1 font-medium">{t(mcp.recipe.transport === 'sse' ? 'transportSse' : 'transportStreamableHttp')}</dd></div>
              <div><dt className="text-muted-foreground">{t('connectorAuthentication')}</dt><dd className="mt-1 font-medium">{t(mcp.recipe.authType === 'bearer' ? 'authBearer' : mcp.recipe.authType === 'headers' ? 'authHeaders' : 'authNone')}</dd></div>
            </>
          ) : (
            <>
              <div><dt className="text-muted-foreground">{t('network')}</dt><dd className="mt-1 font-medium">{mcp.recipe.network === 'none' ? t('networkNone') : t('networkIsolated')}</dd></div>
              <div className="sm:col-span-2"><dt className="text-muted-foreground">{t('packageReference')}</dt><dd className="mt-1 break-all font-mono text-xs">{mcp.recipe.ref}</dd></div>
            </>
          )}
        </dl>
        {!connector && mcp.recipe.env.length ? <div className="mt-5 flex flex-wrap gap-2">{mcp.recipe.env.map((name) => <code key={name} className="ui-chip">{name}</code>)}</div> : null}
      </section>
      {!connector && tools.length ? (
        <McpToolCatalog
          tools={tools}
          labels={{
            title: mcpT('toolCatalog'),
            description: mcpT('toolCatalogDescription'),
            count: mcpT('toolsCount', { count: tools.length }),
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
      ) : null}
    </>
  );
}

function ToolkitDetail({ manifest, checksum, t }: { manifest: unknown; checksum: string; t: Translate }) {
  const toolkit = parseToolkitMarketManifest(manifest, checksum);
  return (
    <section>
      <h2 className="text-lg font-semibold text-foreground">{t('resourceDetails')}</h2>
      <div className="mt-5 grid gap-8 sm:grid-cols-2">
        <div><h3 className="font-medium text-foreground">{t('mcp')}</h3><ul className="mt-3 space-y-2 text-sm text-muted-foreground">{toolkit.mcps.map((mcp) => <li key={mcp.catalogSlug}>{mcp.name}</li>)}</ul></div>
        <div><h3 className="font-medium text-foreground">{t('skills')}</h3><ul className="mt-3 space-y-2 text-sm text-muted-foreground">{toolkit.skills.map((skill, index) => <li key={`${skill.catalogSlug ?? skill.snapshot.slug}-${index}`}>{skill.snapshot.name}</li>)}</ul></div>
      </div>
    </section>
  );
}
