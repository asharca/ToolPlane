'use client';

import { useActionState } from 'react';
import { Save } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { AdminBadge, AdminPanel } from '@/components/admin/AdminUI';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { NativeSelect } from '@/components/ui/NativeSelect';
import {
  updateMarketListingAdminAction,
  updatePublicToolkitAdminAction,
} from '@/lib/admin/market-catalog-actions';
import type { AdminActionState } from '@/lib/admin/user-actions';

type CategoryOption = { id: string; slug: string; name: string };

type ListingRow = {
  id: string;
  kind: string;
  publisherKind: string;
  namespace: string;
  slug: string;
  name: string;
  status: string;
  curated: boolean;
  isFeatured: boolean;
  latestVersion: number;
  installCount: number;
  categories: { id: string }[];
  latestRelease: { reviewStatus: string } | null;
  pendingRelease: { version: number; reviewStatus: string } | null;
};

type ToolkitRow = {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  categories: { id: string }[];
  workspace: { name: string; slug: string };
  _count: { servers: number; skills: number };
};

function CatalogPagination({
  page,
  total,
  pageSize,
  pageParam,
  q,
  otherPageParam,
  otherPage,
  baseHref = '/admin/market',
}: {
  page: number;
  total: number;
  pageSize: number;
  pageParam: 'listingPage' | 'toolkitPage';
  q: string;
  otherPageParam: 'listingPage' | 'toolkitPage';
  otherPage: number;
  baseHref?: string;
}) {
  const t = useTranslations('admin');
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (lastPage <= 1) return null;
  const href = (nextPage: number) => {
    const query = new URLSearchParams();
    if (q) query.set('q', q);
    if (nextPage > 1) query.set(pageParam, String(nextPage));
    if (otherPage > 1) query.set(otherPageParam, String(otherPage));
    return `${baseHref}${query.size ? `?${query.toString()}` : ''}`;
  };
  return (
    <nav aria-label={t('page')} className="flex items-center justify-between gap-3 border-t border-border px-5 py-3 text-xs text-muted-foreground">
      <span>{t('page')} {page} / {lastPage} · {total} {t('items')}</span>
      <div className="flex gap-2">
        {page > 1 ? <Link href={href(page - 1)} className="ui-button-ghost h-8">{t('prev')}</Link> : null}
        {page < lastPage ? <Link href={href(page + 1)} className="ui-button-ghost h-8">{t('next')}</Link> : null}
      </div>
    </nav>
  );
}

export function MarketListingManagement({
  categories,
  listings,
  page,
  pageSize,
  total,
  q,
  baseHref = '/admin/market',
  otherPage = 1,
}: {
  categories: CategoryOption[];
  listings: ListingRow[];
  page: number;
  pageSize: number;
  total: number;
  q: string;
  baseHref?: string;
  otherPage?: number;
}) {
  const t = useTranslations('admin');
  return (
    <AdminPanel
      title={t('marketCatalogListings')}
      description={t('marketCatalogListingsDescription')}
      actions={<AdminBadge tone="neutral">{total}</AdminBadge>}
      padded={false}
    >
      {listings.length ? listings.map((listing) => (
        <ListingForm key={listing.id} listing={listing} categories={categories} />
      )) : <p className="px-5 py-10 text-center text-sm text-muted-foreground">{t('marketCatalogNoListings')}</p>}
      <CatalogPagination
        page={page}
        total={total}
        pageSize={pageSize}
        pageParam="listingPage"
        q={q}
        otherPageParam="toolkitPage"
        otherPage={otherPage}
        baseHref={baseHref}
      />
    </AdminPanel>
  );
}

function CategoryChecklist({
  categories,
  selectedIds,
}: {
  categories: CategoryOption[];
  selectedIds: string[];
}) {
  const t = useTranslations('admin');
  const selected = new Set(selectedIds);
  if (categories.length === 0) return <p className="text-sm text-muted-foreground">{t('none')}</p>;
  return (
    <fieldset>
      <legend className="text-xs font-semibold text-muted-foreground">{t('categories')}</legend>
      <div className="mt-2 grid gap-1 sm:grid-cols-2 xl:grid-cols-3">
        {categories.map((category) => (
          <label key={category.id} className="flex min-h-9 items-center gap-2 rounded px-2 text-sm text-foreground hover:bg-muted/60">
            <input
              type="checkbox"
              name="categoryIds"
              value={category.id}
              defaultChecked={selected.has(category.id)}
              className="size-4 accent-brand"
            />
            <span className="truncate">{category.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ListingForm({ listing, categories }: { listing: ListingRow; categories: CategoryOption[] }) {
  const t = useTranslations('admin');
  const [state, action] = useActionState<AdminActionState, FormData>(updateMarketListingAdminAction, {});
  const statusTone = listing.status === 'published' ? 'success' : listing.status === 'disabled' ? 'danger' : 'neutral';
  return (
    <details className="group border-b border-border last:border-b-0">
      <summary className="flex min-h-14 cursor-pointer list-none flex-wrap items-center gap-2 px-5 py-3 marker:hidden hover:bg-muted/45">
        <span className="min-w-48 flex-1 truncate text-sm font-semibold text-foreground">{listing.name}</span>
        <code className="max-w-72 truncate font-mono text-xs text-muted-foreground">/{listing.namespace}/{listing.slug}</code>
        <AdminBadge tone="neutral">{listing.kind}</AdminBadge>
        <AdminBadge tone={statusTone}>{listing.status}</AdminBadge>
        <span className="text-xs tabular-nums text-muted-foreground">
          v{listing.latestVersion} · {listing.installCount} {t('installsColumn')}
        </span>
      </summary>
      <form action={action} className="space-y-5 border-t border-border bg-muted/20 px-5 py-5">
        <input type="hidden" name="listingId" value={listing.id} />
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="space-y-1.5 text-sm font-medium text-foreground">
            <span>{t('statusColumn')}</span>
            <NativeSelect name="status" defaultValue={listing.status} className="h-10">
              <option value="draft">{t('agentListingStatusDraft')}</option>
              <option value="published">{t('agentListingStatusPublished')}</option>
              <option value="disabled">{t('agentListingStatusDisabled')}</option>
            </NativeSelect>
          </label>
          <label className="flex min-h-10 items-center gap-2 self-end rounded px-2 text-sm font-medium text-foreground hover:bg-muted/60">
            <input type="checkbox" name="curated" defaultChecked={listing.curated} className="size-4 accent-brand" />
            {t('curated')}
          </label>
          <label className="flex min-h-10 items-center gap-2 self-end rounded px-2 text-sm font-medium text-foreground hover:bg-muted/60">
            <input type="checkbox" name="isFeatured" defaultChecked={listing.isFeatured} className="size-4 accent-brand" />
            {t('featured')}
          </label>
        </div>
        <CategoryChecklist categories={categories} selectedIds={listing.categories.map(({ id }) => id)} />
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton
            error={state.error}
            pendingLabel={t('saving')}
            savedLabel={t('saved')}
            className="ui-button-primary h-10"
          >
            <Save className="size-4" />
            {t('saveChanges')}
          </SubmitButton>
          {listing.kind === 'assistant' && listing.publisherKind === 'platform' ? (
            <Link href={`/admin/assistants/${encodeURIComponent(listing.id)}/edit`} className="ui-button-secondary h-10">
              {t('edit')}
            </Link>
          ) : null}
          {listing.pendingRelease ? (
            <span className="text-xs text-amber-700 dark:text-amber-300">
              {t('marketCatalogPendingRelease', { version: listing.pendingRelease.version })}
            </span>
          ) : null}
          {listing.latestRelease ? (
            <span className="text-xs text-muted-foreground">
              {t('marketCatalogLatestReleaseStatus', { status: listing.latestRelease.reviewStatus })}
            </span>
          ) : null}
          {state.error ? <p role="alert" className="text-sm text-destructive-text">{state.error}</p> : null}
        </div>
      </form>
    </details>
  );
}

function ToolkitForm({ toolkit, categories }: { toolkit: ToolkitRow; categories: CategoryOption[] }) {
  const t = useTranslations('admin');
  const [state, action] = useActionState<AdminActionState, FormData>(updatePublicToolkitAdminAction, {});
  return (
    <details className="group border-b border-border last:border-b-0">
      <summary className="flex min-h-14 cursor-pointer list-none flex-wrap items-center gap-2 px-5 py-3 marker:hidden hover:bg-muted/45">
        <span className="min-w-48 flex-1 truncate text-sm font-semibold text-foreground">{toolkit.name}</span>
        <code className="max-w-72 truncate font-mono text-xs text-muted-foreground">/{toolkit.workspace.slug}/{toolkit.slug}</code>
        <AdminBadge tone={toolkit.enabled ? 'success' : 'danger'}>
          {toolkit.enabled ? t('active') : t('agentListingStatusDisabled')}
        </AdminBadge>
        <span className="text-xs text-muted-foreground">
          {t('marketToolkitResourceCounts', { servers: toolkit._count.servers, skills: toolkit._count.skills })}
        </span>
      </summary>
      <form action={action} className="space-y-5 border-t border-border bg-muted/20 px-5 py-5">
        <input type="hidden" name="toolkitId" value={toolkit.id} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-foreground">{toolkit.workspace.name}</p>
            <p className="text-xs text-muted-foreground">{t('marketToolkitLegacyNotice')}</p>
          </div>
          <label className="flex min-h-10 items-center gap-2 rounded px-2 text-sm font-medium text-foreground hover:bg-muted/60">
            <input type="checkbox" name="enabled" defaultChecked={toolkit.enabled} className="size-4 accent-brand" />
            {t('enabled')}
          </label>
        </div>
        <CategoryChecklist categories={categories} selectedIds={toolkit.categories.map(({ id }) => id)} />
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton
            error={state.error}
            pendingLabel={t('saving')}
            savedLabel={t('saved')}
            className="ui-button-primary h-10"
          >
            <Save className="size-4" />
            {t('saveChanges')}
          </SubmitButton>
          {state.error ? <p role="alert" className="text-sm text-destructive-text">{state.error}</p> : null}
        </div>
      </form>
    </details>
  );
}

export function MarketCatalogManagement({
  categories,
  listings,
  toolkits,
  listingPage,
  listingPageSize,
  listingTotal,
  toolkitPage,
  toolkitPageSize,
  toolkitTotal,
  q,
}: {
  categories: CategoryOption[];
  listings: ListingRow[];
  toolkits: ToolkitRow[];
  listingPage: number;
  listingPageSize: number;
  listingTotal: number;
  toolkitPage: number;
  toolkitPageSize: number;
  toolkitTotal: number;
  q: string;
}) {
  const t = useTranslations('admin');
  return (
    <div className="space-y-6">
      <MarketListingManagement
        categories={categories}
        listings={listings}
        page={listingPage}
        pageSize={listingPageSize}
        total={listingTotal}
        q={q}
        otherPage={toolkitPage}
      />

      <AdminPanel
        title={t('marketCatalogPublicToolkits')}
        description={t('marketCatalogPublicToolkitsDescription')}
        actions={<AdminBadge tone="neutral">{toolkitTotal}</AdminBadge>}
        padded={false}
      >
        {toolkits.length ? toolkits.map((toolkit) => (
          <ToolkitForm key={toolkit.id} toolkit={toolkit} categories={categories} />
        )) : <p className="px-5 py-10 text-center text-sm text-muted-foreground">{t('marketCatalogNoPublicToolkits')}</p>}
        <CatalogPagination
          page={toolkitPage}
          total={toolkitTotal}
          pageSize={toolkitPageSize}
          pageParam="toolkitPage"
          q={q}
          otherPageParam="listingPage"
          otherPage={listingPage}
        />
      </AdminPanel>
    </div>
  );
}
