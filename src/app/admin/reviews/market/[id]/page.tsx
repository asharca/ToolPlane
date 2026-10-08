import { Buffer } from 'node:buffer';
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
import { parsePiPackageReleaseManifest, scanPiPackageReleaseManifest } from '@/lib/market/pi-package-manifest';

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

function readPiPackageReview(value: unknown, checksum: string, notes: string | null) {
  try {
    const manifest = parsePiPackageReleaseManifest(value, checksum);
    const scan = scanPiPackageReleaseManifest(manifest, notes);
    return scan.status === 'blocked' ? null : { manifest, scan };
  } catch {
    return null;
  }
}

function decodedFileSize(content: string): number {
  return content.length / 4 * 3 - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0);
}

function previewText(content: string): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(content, 'base64'));
    return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) ? null : text;
  } catch {
    return null;
  }
}

export default async function AdminMarketReviewPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ releaseId?: string; returnTo?: string; path?: string }>;
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
          categories: { select: { id: true } },
          releases: { take: 20, orderBy: { version: 'desc' }, select: { id: true, version: true, reviewStatus: true, reviewNote: true, reviewedAt: true, reviewedBy: { select: { name: true, email: true } } } },
        } },
      },
    }),
    listCategories(),
  ]);
  if (!selectedRelease) notFound();
  if (!query.releaseId) redirect(adminHref(`/admin/reviews/market/${id}`, { releaseId: selectedRelease.id, returnTo: backHref, path: query.path }));
  const release = selectedRelease;
  const listing = release.listing;
  const previousRelease = listing.kind === 'pi-package' ? null : await db.marketRelease.findFirst({ where: { listingId: id, version: { lt: release.version }, reviewStatus: 'approved' }, orderBy: { version: 'desc' }, select: { manifest: true } });
  const publisher = listing.publisherWorkspace?.name ?? listing.publishedBy?.name ?? listing.publishedBy?.email ?? listing.publisherKind;
  const skillManifest = listing.kind === 'skill' ? readSkillManifest(release.manifest, release.checksum) : null;
  const assistantManifest = listing.kind === 'assistant' ? readAssistantManifest(release.manifest, release.checksum) : null;
  const mcpManifest = listing.kind === 'mcp' ? readMcpManifest(release.manifest, release.checksum) : null;
  const toolkitManifest = listing.kind === 'toolkit' ? readToolkitManifest(release.manifest, release.checksum) : null;
  const piReview = listing.kind === 'pi-package' ? readPiPackageReview(release.manifest, release.checksum, release.releaseNotes) : null;
  const piManifest = piReview?.manifest ?? null;
  const piScan = piReview?.scan ?? null;
  const selectedFile = piManifest?.package.entries.find((entry) => entry.type === 'file' && entry.path === query.path);
  const selectedText = selectedFile?.type === 'file' ? previewText(selectedFile.content) : null;

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
                    <div className="flex items-start gap-3 bg-muted p-4 text-sm leading-6 text-muted-foreground">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      <p>
                        {listing.kind === 'pi-package'
                          ? t('marketPiPackageSafetyNotice')
                          : listing.kind === 'assistant'
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
                    ) : piManifest ? (
                      <div className="min-w-0 space-y-5">
                        <section>
                          <h3 className="text-sm font-semibold">{t('marketPiPackageProvenance')}</h3>
                          <dl className="mt-2 space-y-2 break-all font-mono text-xs">
                            <div><dt className="text-muted-foreground">{t('marketPiPackageNameVersion')}</dt><dd>{piManifest.package.name} @ {piManifest.package.version ?? '—'}</dd></div>
                            <div><dt className="text-muted-foreground">{t('marketPiPackageRequestedSource')}</dt><dd>{piManifest.package.source.requested}</dd></div>
                            {piManifest.package.source.kind === 'npm' ? <>
                              <div><dt className="text-muted-foreground">npm</dt><dd>{piManifest.package.source.name} @ {piManifest.package.source.version}</dd></div>
                              <div><dt className="text-muted-foreground">{t('marketPiPackageIntegrity')}</dt><dd>{piManifest.package.source.integrity}</dd></div>
                            </> : piManifest.package.source.kind === 'git' ? <>
                              <div><dt className="text-muted-foreground">Git HTTPS</dt><dd>{piManifest.package.source.url}</dd></div>
                              <div><dt className="text-muted-foreground">{t('marketPiPackageCommit')}</dt><dd>{piManifest.package.source.commit}</dd></div>
                            </> : <div><dt className="text-muted-foreground">ToolPlane</dt><dd>{piManifest.package.source.name} @ {piManifest.package.source.version}</dd></div>}
                            <div><dt className="text-muted-foreground">{t('marketPiPackageRuntime')}</dt><dd>{piManifest.package.runtime.kind} · Pi {piManifest.package.runtime.piVersion} · Node {piManifest.package.runtime.nodeMajor} · {piManifest.package.runtime.platform}/{piManifest.package.runtime.arch}</dd></div>
                          </dl>
                        </section>
                        <section>
                          <h3 className="text-sm font-semibold">{t('marketPiPackageResources')}</h3>
                          {Object.entries(piManifest.package.resources).map(([kind, paths]) => <div key={kind} className="mt-2 text-xs">
                            <h4 className="font-medium">{kind}</h4>
                            <ul className="mt-1 space-y-1 break-all font-mono">{paths.map((path) => <li key={path}>{path}</li>)}</ul>
                          </div>)}
                        </section>
                        <section>
                          <h3 className="text-sm font-semibold">{t('marketPiPackageInventory')}</h3>
                          <p className="mt-1 text-xs text-muted-foreground">{t('marketPiPackageInventoryTotals', {
                            count: piManifest.package.entries.filter((entry) => entry.type === 'file').length,
                            bytes: piManifest.package.entries.reduce((total, entry) => total + (entry.type === 'file' ? decodedFileSize(entry.content) : 0), 0),
                          })}</p>
                          <div className="mt-2 max-h-[36rem] overflow-auto border-y border-border">
                            <table className="w-full text-left font-mono text-xs">
                              <thead><tr><th className="p-2">{t('marketPiPackagePath')}</th><th className="p-2">{t('marketPiPackageBytes')}</th><th className="p-2">SHA-256 / {t('marketPiPackageEntryType')}</th></tr></thead>
                              <tbody>{piManifest.package.entries.map((entry) => <tr key={entry.path} className="border-t border-border/60 align-top">
                                <td className="break-all p-2">{entry.type === 'file' ? <Link className="underline" href={adminHref(`/admin/reviews/market/${id}`, { releaseId: release.id, returnTo: backHref, path: entry.path })}>{entry.path}</Link> : entry.path}</td>
                                <td className="whitespace-nowrap p-2">{entry.type === 'file' ? decodedFileSize(entry.content) : '—'}</td>
                                <td className="break-all p-2">{entry.type === 'file' ? <>{entry.sha256}{entry.executable ? <span className="block">{t('marketPiPackageExecutable')}</span> : null}</> : entry.type === 'symlink' ? `symlink → ${entry.target}` : entry.type}</td>
                              </tr>)}</tbody>
                            </table>
                          </div>
                        </section>
                        {selectedFile?.type === 'file' ? <section>
                          <h3 className="break-all font-mono text-sm font-semibold">{selectedFile.path}</h3>
                          <p className="mt-1 break-all font-mono text-xs">{decodedFileSize(selectedFile.content)} bytes · SHA-256 {selectedFile.sha256}</p>
                          {selectedText !== null ? <pre className="mt-2 max-h-[36rem] overflow-auto whitespace-pre-wrap break-words bg-muted/45 p-3 font-mono text-xs leading-6">{selectedText}</pre> : <p className="mt-2 text-sm text-muted-foreground">{t('marketPiPackageBinaryPreview')}</p>}
                        </section> : query.path ? <p role="alert" className="text-sm text-destructive">{t('marketPiPackageFileMissing')}</p> : null}
                      </div>
                    ) : (
                      <p role="alert" className="text-sm text-destructive">{t('errorInvalidMarketRelease')}</p>
                    )}

                    {listing.kind !== 'pi-package' ? <details className="border-y border-border py-3">
                      <summary className="cursor-pointer text-sm font-semibold text-foreground">
                        {t('marketReleaseManifestJson')}
                      </summary>
                      <pre className="mt-3 max-h-[48rem] overflow-auto whitespace-pre-wrap break-words bg-muted/45 p-3 font-mono text-xs leading-6 text-foreground">
                        {JSON.stringify(release.manifest, null, 2)}
                      </pre>
                    </details> : null}

                    {(listing.kind === 'pi-package' ? piScan : release.scanResult) !== null ? (
                      <details open className="border-b border-border pb-3">
                        <summary className="cursor-pointer text-sm font-semibold text-foreground">
                          {t('marketReleaseScanResult')}
                        </summary>
                        <pre className="mt-3 max-h-[36rem] overflow-auto whitespace-pre-wrap break-words bg-muted/45 p-3 font-mono text-xs leading-6 text-foreground">
                          {JSON.stringify(listing.kind === 'pi-package' ? piScan : release.scanResult, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </div>

                  {release.reviewStatus === 'pending' && listing.pendingReleaseId === release.id ? <MarketReleaseReviewActions
                    listingId={listing.id}
                    releaseId={release.id}
                    approvalAllowed={listing.kind !== 'pi-package' || piManifest !== null}
                    categories={categories}
                    selectedCategoryIds={release.categoryIds?.length
                      ? release.categoryIds
                      : listing.categories.map(({ id }) => id)}
                  /> : <div className="space-y-3 text-sm"><p>{ops('reviewer')}: {release.reviewedBy?.name ?? release.reviewedBy?.email ?? '-'}</p>{release.reviewedAt ? <LogTimestamp date={release.reviewedAt} /> : null}<p className="whitespace-pre-wrap break-words">{ops('reviewNote')}: {release.reviewNote ?? '-'}</p></div>}
                </div>
              </AdminPanel>
      </section>
      {listing.kind !== 'pi-package' ? <ReleaseChanges before={previousRelease?.manifest ?? null} after={release.manifest} /> : null}
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
