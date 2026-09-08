import { AlertTriangle } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  AdminBadge,
  AdminPage,
  AdminPageHeader,
  AdminPanel,
} from '@/components/admin/AdminUI';
import { ReleaseChanges } from '@/components/admin/ReleaseChanges';
import { LogTimestamp } from '@/components/admin/LogUI';
import { adminHref, adminReturnHref } from '@/lib/admin/navigation';
import { MarketReleaseReviewActions } from '@/components/admin/MarketReleaseReviewActions';
import { listCategories } from '@/lib/admin/categories';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/db';
import { parseAssistantReleaseManifest } from '@/lib/market/assistant-manifest';
import { parseSkillReleaseManifest } from '@/lib/market/skill-manifest';
import { parseMcpMarketManifest, parseToolkitMarketManifest } from '@/lib/market/resources';

export const dynamic = 'force-dynamic';

function readSkillManifest(value: unknown, checksum: string) {
  try {
    return parseSkillReleaseManifest(value, checksum);
  } catch {
    return null;
  }
}

function readAssistantManifest(value: unknown, checksum: string) {
  try {
    return parseAssistantReleaseManifest(value, checksum);
  } catch {
    return null;
  }
}

function readMcpManifest(value: unknown, checksum: string) {
  try {
    return parseMcpMarketManifest(value, checksum);
  } catch {
    return null;
  }
}

function readToolkitManifest(value: unknown, checksum: string) {
  try {
    return parseToolkitMarketManifest(value, checksum);
  } catch {
    return null;
  }
}

export default async function AdminMarketReviewPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ releaseId?: string; returnTo?: string }>;
}) {
  await requireAdmin();
  const [t, ops, query, { id }] = await Promise.all([getTranslations('admin'), getTranslations('adminOps'), searchParams, params]);
  const backHref = adminReturnHref(query.returnTo, '/admin/reviews');
  const [selectedRelease, categories] = await Promise.all([
    db.marketRelease.findFirst({
      where: { listingId: id, ...(query.releaseId ? { id: query.releaseId } : { pendingFor: { is: { id } } }) },
      include: {
        reviewedBy: { select: { name: true, email: true } },
        listing: { include: {
          publisherWorkspace: { select: { name: true } }, publishedBy: { select: { name: true, email: true } },
          categories: { select: { id: true } }, latestRelease: { select: { manifest: true, version: true } },
          releases: { take: 20, orderBy: { version: 'desc' }, select: { id: true, version: true, reviewStatus: true, reviewNote: true, reviewedAt: true, reviewedBy: { select: { name: true, email: true } } } },
        } },
      },
    }),
    listCategories(),
  ]);
  if (!selectedRelease) notFound();
  if (!query.releaseId) redirect(adminHref(`/admin/reviews/market/${id}`, { releaseId: selectedRelease.id, returnTo: backHref }));
  const release = selectedRelease;
  const listing = release.listing;
  const previousRelease = await db.marketRelease.findFirst({ where: { listingId: id, version: { lt: release.version }, reviewStatus: 'approved' }, orderBy: { version: 'desc' }, select: { manifest: true } });
  const publisher = listing.publisherWorkspace?.name ?? listing.publishedBy?.name ?? listing.publishedBy?.email ?? listing.publisherKind;
  const skillManifest = listing.kind === 'skill' ? readSkillManifest(release.manifest, release.checksum) : null;
  const assistantManifest = listing.kind === 'assistant' ? readAssistantManifest(release.manifest, release.checksum) : null;
  const mcpManifest = listing.kind === 'mcp' ? readMcpManifest(release.manifest, release.checksum) : null;
  const toolkitManifest = listing.kind === 'toolkit' ? readToolkitManifest(release.manifest, release.checksum) : null;

  return (
    <AdminPage>
      <AdminPageHeader
        title={selectedRelease.listing.name}
        description={`v${selectedRelease.version}`}
        backHref={backHref}
        backLabel={ops('reviewQueue')}
        meta={<AdminBadge tone={selectedRelease.reviewStatus === 'pending' ? 'warning' : selectedRelease.reviewStatus === 'approved' ? 'success' : 'danger'}>{ops.has(selectedRelease.reviewStatus) ? ops(selectedRelease.reviewStatus) : selectedRelease.reviewStatus}</AdminBadge>}
      />

      <section className="space-y-4" aria-labelledby="market-release-reviews">
        <div>
          <h2 id="market-release-reviews" className="text-lg font-semibold text-foreground">{t('marketReleaseReviews')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('marketReleaseReviewsDescription')}</p>
          <p className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">{ops('submittedAt')}: <LogTimestamp date={selectedRelease.createdAt} /></p>
        </div>

              <AdminPanel
                key={release.id}
                title={listing.name}
                description={`/${listing.namespace}/${listing.slug} · v${release.version}`}
                actions={<AdminBadge tone="warning" dot>{listing.kind}</AdminBadge>}
              >
                <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
                  <div className="min-w-0 space-y-5">
                    <div className="flex items-start gap-3 bg-amber-500/10 p-4 text-sm leading-6 text-amber-800 dark:text-amber-200">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      <p>
                        {listing.kind === 'assistant'
                          ? t('marketAssistantReleaseSafetyNotice')
                          : listing.kind === 'mcp' || listing.kind === 'toolkit'
                            ? t('marketResourceReleaseSafetyNotice')
                            : t('marketReleaseSafetyNotice')}
                      </p>
                    </div>

                    <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">{t('marketReleasePublisher')}</dt>
                        <dd className="mt-1 text-sm text-foreground">{publisher}</dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">{t('marketReleaseNamespace')}</dt>
                        <dd className="mt-1 font-mono text-sm text-foreground">{listing.namespace}</dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="text-xs font-medium text-muted-foreground">{t('marketReleaseNotes')}</dt>
                        <dd className="mt-1 whitespace-pre-wrap text-sm text-foreground">
                          {release.releaseNotes || t('marketReleaseNotesEmpty')}
                        </dd>
                      </div>
                      <div className="min-w-0 sm:col-span-2">
                        <dt className="text-xs font-medium text-muted-foreground">{t('marketReleaseSummary')}</dt>
                        <dd className="mt-1">
                          <pre className="overflow-x-auto whitespace-pre-wrap break-words bg-muted/45 p-3 font-mono text-xs text-foreground">
                            {JSON.stringify(release.releaseSummary, null, 2)}
                          </pre>
                        </dd>
                      </div>
                      <div className="min-w-0 sm:col-span-2">
                        <dt className="text-xs font-medium text-muted-foreground">{t('agentReleaseChecksum')}</dt>
                        <dd className="mt-1 break-all font-mono text-xs text-foreground">{release.checksum}</dd>
                      </div>
                    </dl>

                    {skillManifest ? (
                      <>
                        <section>
                          <h3 className="text-sm font-semibold text-foreground">{t('marketReleaseSkillMarkdown')}</h3>
                          <pre className="mt-2 max-h-[36rem] overflow-auto whitespace-pre-wrap break-words bg-muted/45 p-3 font-mono text-xs leading-6 text-foreground">
                            {skillManifest.skill.content}
                          </pre>
                        </section>

                        <section>
                          <h3 className="text-sm font-semibold text-foreground">
                            {t('marketReleaseBundledFiles', { count: skillManifest.skill.files.length })}
                          </h3>
                          {skillManifest.skill.files.length > 0 ? (
                            <div className="mt-2 divide-y divide-border border-y border-border">
                              {skillManifest.skill.files.map((file) => (
                                <details key={file.path}>
                                  <summary className="flex cursor-pointer items-center justify-between gap-3 py-3 font-mono text-xs text-foreground">
                                    <span className="min-w-0 break-all">{file.path}</span>
                                    <span className="shrink-0 text-muted-foreground">{file.encoding ?? 'utf8'}</span>
                                  </summary>
                                  <pre className="mb-3 max-h-[36rem] overflow-auto whitespace-pre-wrap break-words bg-muted/45 p-3 font-mono text-xs leading-6 text-foreground">
                                    {file.content}
                                  </pre>
                                </details>
                              ))}
                            </div>
                          ) : (
                            <p className="mt-2 text-sm text-muted-foreground">{t('marketReleaseNoBundledFiles')}</p>
                          )}
                        </section>
                      </>
                    ) : assistantManifest ? (
                      <>
                        <section>
                          <h3 className="text-sm font-semibold text-foreground">{t('marketAssistantInstructions')}</h3>
                          <pre className="mt-2 max-h-[36rem] overflow-auto whitespace-pre-wrap break-words bg-muted/45 p-3 font-mono text-xs leading-6 text-foreground">
                            {assistantManifest.assistant.systemPrompt || t('marketAssistantInstructionsEmpty')}
                          </pre>
                        </section>

                        <section>
                          <h3 className="text-sm font-semibold text-foreground">{t('marketAssistantConfiguration')}</h3>
                          <dl className="mt-2 divide-y divide-border/60 border-y border-border/60 text-xs">
                            <div className="flex justify-between gap-4 py-2.5">
                              <dt className="text-muted-foreground">{t('marketAssistantModel')}</dt>
                              <dd className="text-right font-medium text-foreground">
                                {assistantManifest.assistant.modelRequirement?.model ?? t('marketAssistantNotSpecified')}
                              </dd>
                            </div>
                            <div className="flex justify-between gap-4 py-2.5">
                              <dt className="text-muted-foreground">{t('marketAssistantProviderFormat')}</dt>
                              <dd className="text-right font-medium text-foreground">
                                {assistantManifest.assistant.modelRequirement?.providerFormat ?? t('marketAssistantNotSpecified')}
                              </dd>
                            </div>
                            <div className="flex justify-between gap-4 py-2.5">
                              <dt className="text-muted-foreground">{t('marketAssistantMaximumSteps')}</dt>
                              <dd className="font-medium text-foreground">{assistantManifest.assistant.maxSteps}</dd>
                            </div>
                          </dl>
                        </section>

                        <section>
                          <h3 className="text-sm font-semibold text-foreground">
                            {t('marketAssistantMcpRequirements', { count: assistantManifest.assistant.mcpRequirements.length })}
                          </h3>
                          {assistantManifest.assistant.mcpRequirements.length ? (
                            <div className="mt-2 divide-y divide-border/60 border-y border-border/60">
                              {assistantManifest.assistant.mcpRequirements.map((mcp) => (
                                <div key={mcp.catalogSlug} className="flex justify-between gap-4 py-2.5 text-xs">
                                  <span className="font-medium text-foreground">{mcp.name}</span>
                                  <code className="text-muted-foreground">{mcp.catalogSlug}</code>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="mt-2 text-sm text-muted-foreground">{t('marketAssistantNoMcpRequirements')}</p>
                          )}
                        </section>
                      </>
                    ) : mcpManifest ? (
                      <section>
                        <h3 className="text-sm font-semibold text-foreground">{t('marketMcpConfiguration')}</h3>
                        <dl className="mt-2 divide-y divide-border/60 border-y border-border/60 text-xs">
                          <div className="flex justify-between gap-4 py-2.5">
                            <dt className="text-muted-foreground">{t('marketMcpPackageReference')}</dt>
                            <dd className="max-w-[70%] break-all text-right font-mono text-foreground">{mcpManifest.mcp.recipe.source}:{mcpManifest.mcp.recipe.ref}</dd>
                          </div>
                          <div className="flex justify-between gap-4 py-2.5">
                            <dt className="text-muted-foreground">{t('marketMcpToolExposure')}</dt>
                            <dd className="font-medium text-foreground">{mcpManifest.mcp.toolExposure}</dd>
                          </div>
                          <div className="py-2.5">
                            <dt className="text-muted-foreground">{t('marketMcpEnvironment')}</dt>
                            <dd className="mt-2 flex flex-wrap gap-1.5">
                              {mcpManifest.mcp.recipe.env.length
                                ? mcpManifest.mcp.recipe.env.map((name) => <code key={name} className="rounded bg-muted px-2 py-1">{name}</code>)
                                : <span className="text-foreground">—</span>}
                            </dd>
                          </div>
                          <div className="py-2.5">
                            <dt className="text-muted-foreground">{t('marketMcpAllowedTools')}</dt>
                            <dd className="mt-2 flex flex-wrap gap-1.5">
                              {mcpManifest.mcp.allowedTools.length
                                ? mcpManifest.mcp.allowedTools.map((name) => <code key={name} className="rounded bg-muted px-2 py-1">{name}</code>)
                                : <span className="text-foreground">—</span>}
                            </dd>
                          </div>
                        </dl>
                      </section>
                    ) : toolkitManifest ? (
                      <section>
                        <h3 className="text-sm font-semibold text-foreground">{t('marketToolkitContents')}</h3>
                        <div className="mt-2 grid gap-5 sm:grid-cols-2">
                          <div>
                            <h4 className="text-xs font-medium text-muted-foreground">{t('marketToolkitMcps', { count: toolkitManifest.mcps.length })}</h4>
                            <ul className="mt-2 divide-y divide-border/60 border-y border-border/60 text-xs">
                              {toolkitManifest.mcps.map((mcp) => (
                                <li key={mcp.catalogSlug} className="py-2.5">
                                  <span className="font-medium text-foreground">{mcp.name}</span>
                                  <code className="ml-2 text-muted-foreground">{mcp.catalogSlug}</code>
                                  {mcp.recipe.env.length ? <p className="mt-1 text-muted-foreground">{mcp.recipe.env.join(', ')}</p> : null}
                                </li>
                              ))}
                            </ul>
                          </div>
                          <div>
                            <h4 className="text-xs font-medium text-muted-foreground">{t('marketToolkitSkills', { count: toolkitManifest.skills.length })}</h4>
                            <ul className="mt-2 divide-y divide-border/60 border-y border-border/60 text-xs">
                              {toolkitManifest.skills.map((skill, index) => (
                                <li key={`${skill.catalogSlug ?? skill.snapshot.slug}-${index}`} className="py-2.5">
                                  <span className="font-medium text-foreground">{skill.snapshot.name}</span>
                                  {skill.catalogSlug ? <code className="ml-2 text-muted-foreground">{skill.catalogSlug}</code> : null}
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      </section>
                    ) : (
                      <p role="alert" className="text-sm text-destructive-text">{t('errorInvalidMarketRelease')}</p>
                    )}

                    <details className="border-y border-border py-3">
                      <summary className="cursor-pointer text-sm font-semibold text-foreground">
                        {t('marketReleaseManifestJson')}
                      </summary>
                      <pre className="mt-3 max-h-[48rem] overflow-auto whitespace-pre-wrap break-words bg-muted/45 p-3 font-mono text-xs leading-6 text-foreground">
                        {JSON.stringify(release.manifest, null, 2)}
                      </pre>
                    </details>

                    {release.scanResult !== null ? (
                      <details open className="border-b border-border pb-3">
                        <summary className="cursor-pointer text-sm font-semibold text-foreground">
                          {t('marketReleaseScanResult')}
                        </summary>
                        <pre className="mt-3 max-h-[36rem] overflow-auto whitespace-pre-wrap break-words bg-muted/45 p-3 font-mono text-xs leading-6 text-foreground">
                          {JSON.stringify(release.scanResult, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </div>

                  {release.reviewStatus === 'pending' && listing.pendingReleaseId === release.id ? <MarketReleaseReviewActions
                    listingId={listing.id}
                    releaseId={release.id}
                    categories={categories}
                    selectedCategoryIds={release.categoryIds?.length
                      ? release.categoryIds
                      : listing.categories.map(({ id }) => id)}
                  /> : <div className="space-y-3 text-sm"><p>{ops('reviewer')}: {release.reviewedBy?.name ?? release.reviewedBy?.email ?? '-'}</p>{release.reviewedAt ? <LogTimestamp date={release.reviewedAt} /> : null}<p className="whitespace-pre-wrap break-words">{ops('reviewNote')}: {release.reviewNote ?? '-'}</p></div>}
                </div>
              </AdminPanel>
      </section>
      <ReleaseChanges before={previousRelease?.manifest ?? null} after={release.manifest} />
      <AdminPanel title={ops('reviewHistory')}>
        <ul className="divide-y divide-border">{selectedRelease.listing.releases.map((release) => <li key={release.id} className="py-3 text-sm">
          <Link href={adminHref(`/admin/reviews/market/${id}`, { releaseId: release.id, returnTo: backHref })} className="font-medium hover:underline">v{release.version} / {ops.has(release.reviewStatus) ? ops(release.reviewStatus) : release.reviewStatus}</Link>
          <p className="mt-1 text-xs text-muted-foreground">{release.reviewedBy?.name ?? release.reviewedBy?.email ?? '-'}{release.reviewedAt ? ` / ${release.reviewedAt.toISOString()}` : ''}</p>
          {release.reviewNote ? <p className="mt-1 whitespace-pre-wrap break-words">{release.reviewNote}</p> : null}
        </li>)}</ul>
      </AdminPanel>
    </AdminPage>
  );
}
