import { AlertTriangle, Download, FileLock2 } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { AdminBadge, AdminPanel } from '@/components/admin/AdminUI';
import { AgentReleaseReviewActions } from '@/components/admin/AgentReleaseReviewActions';

type PendingRelease = {
  id: string;
  version: number;
  name: string;
  summary: string | null;
  iconUrl: string | null;
  tags: string[];
  checksum: string;
  publishedAt: string;
  manifest: {
    rootAgentKey: string;
    agents: Array<{
      key: string;
      name: string;
      systemPrompt: string | null;
      modelRequirement: { format: string; model: string } | null;
    }>;
    deployments: Array<{ key: string; name: string; catalogSlug: string }>;
    skills: Array<{ key: string; name: string; origin: string; catalogSlug?: string }>;
    toolkits: Array<{ key: string; name: string }>;
  };
};

export async function AgentReleaseReview({
  listingId,
  release,
}: {
  listingId: string;
  release: PendingRelease;
}) {
  const t = await getTranslations('admin');
  const rootAgent = release.manifest.agents.find(({ key }) => key === release.manifest.rootAgentKey);

  return (
    <AdminPanel
      title={t('agentPendingRelease', { version: release.version })}
      description={t('agentPendingReleaseDescription')}
      tone="danger"
      actions={<AdminBadge tone="warning" dot>{t('agentReviewPending')}</AdminBadge>}
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,.75fr)]">
        <div className="min-w-0 space-y-5">
          <div className="flex items-start gap-3 rounded-md bg-amber-500/10 p-4 text-sm leading-6 text-amber-800 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>{t('agentReviewSafetyNotice')}</p>
          </div>

          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">{t('name')}</dt>
              <dd className="mt-1 font-semibold text-foreground">{release.name}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">{t('agentReleaseChecksum')}</dt>
              <dd className="mt-1 truncate font-mono text-xs text-foreground">sha256:{release.checksum}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">{t('agentReleaseResources')}</dt>
              <dd className="mt-1 text-foreground">
                {t('agentReleaseResourceCounts', {
                  agents: release.manifest.agents.length,
                  servers: release.manifest.deployments.length,
                  skills: release.manifest.skills.length,
                  toolkits: release.manifest.toolkits.length,
                })}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">{t('agentModelId')}</dt>
              <dd className="mt-1 font-mono text-xs text-foreground">
                {rootAgent?.modelRequirement
                  ? `${rootAgent.modelRequirement.format} / ${rootAgent.modelRequirement.model}`
                  : t('agentNoModelRequirement')}
              </dd>
            </div>
          </dl>

          {release.summary ? (
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground">{t('description')}</h3>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">{release.summary}</p>
            </div>
          ) : null}

          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <FileLock2 className="size-4 text-muted-foreground" />
              <h3 className="text-xs font-semibold text-muted-foreground">{t('agentAllSystemPrompts')}</h3>
            </div>
            {release.manifest.agents.map((agent) => (
              <div key={agent.key} className="rounded-md border border-border bg-muted/20 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{agent.name}</span>
                  <code className="text-[11px] text-muted-foreground">{agent.key}</code>
                  {agent.key === release.manifest.rootAgentKey ? (
                    <AdminBadge tone="brand">{t('agentRootDefinition')}</AdminBadge>
                  ) : null}
                </div>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-background/80 p-3 font-mono text-xs leading-6 text-foreground">
                  {agent.systemPrompt
                    ? agent.systemPrompt.length > 20_000
                      ? `${agent.systemPrompt.slice(0, 20_000)}\n\n${t('agentPromptPreviewTruncated')}`
                      : agent.systemPrompt
                    : t('agentNoSystemPrompt')}
                </pre>
              </div>
            ))}
          </div>

          {(release.manifest.deployments.length > 0 || release.manifest.skills.length > 0) ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <h3 className="text-xs font-semibold text-muted-foreground">{t('agentCatalogServers')}</h3>
                <ul className="mt-2 space-y-1 text-sm text-foreground">
                  {release.manifest.deployments.map((item) => (
                    <li key={item.key}>{item.name} <code className="text-xs text-muted-foreground">/{item.catalogSlug}</code></li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-xs font-semibold text-muted-foreground">{t('agentCatalogSkills')}</h3>
                <ul className="mt-2 space-y-1 text-sm text-foreground">
                  {release.manifest.skills.map((item) => (
                    <li key={item.key}>{item.name} <AdminBadge tone="neutral">{item.origin}</AdminBadge></li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          <div className="rounded-md border border-border bg-muted/20 p-4">
            <h3 className="text-sm font-semibold text-foreground">{t('agentCompleteArtifact')}</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t('agentCompleteArtifactDescription')}
            </p>
            <a
              href={`/api/v1/admin/agent-releases/${encodeURIComponent(release.id)}/manifest`}
              target="_blank"
              rel="noreferrer"
              className="ui-button-secondary mt-4 inline-flex h-9 gap-2 px-3 text-xs"
            >
              <Download className="size-4" />
              {t('agentOpenCompleteArtifact')}
            </a>
          </div>
        </div>

        <AgentReleaseReviewActions listingId={listingId} releaseId={release.id} />
      </div>
    </AdminPanel>
  );
}
