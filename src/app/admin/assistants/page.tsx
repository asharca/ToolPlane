import { Plus } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import {
  AdminPage,
  AdminPageHeader,
  AdminSearchForm,
} from '@/components/admin/AdminUI';
import { MarketListingManagement } from '@/components/admin/MarketCatalogManagement';
import { listCategories } from '@/lib/admin/categories';
import { listAdminMarketListings } from '@/lib/admin/market-catalog';
import { requireAdmin } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export default async function AdminAssistantsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; listingPage?: string | string[] }>;
}) {
  await requireAdmin();
  const [t, query] = await Promise.all([getTranslations('admin'), searchParams]);
  const q = firstParam(query.q).trim().slice(0, 200);
  const page = Number(firstParam(query.listingPage));
  const [result, categories] = await Promise.all([
    listAdminMarketListings({ kind: 'assistant', q, page }),
    listCategories(),
  ]);

  return (
    <AdminPage>
      <AdminPageHeader
        title={t('directoryAssistants')}
        description={t('assistantsDirectoryDescription')}
        meta={t('assistantListingCount', { count: result.total.toLocaleString() })}
        actions={(
          <Link href="/admin/assistants/new" className="ui-button-primary">
            <Plus className="size-4" aria-hidden="true" />
            {t('addAssistantTemplate')}
          </Link>
        )}
      />

      <AdminSearchForm
        defaultValue={q}
        placeholder={t('searchAssistantListings')}
        label={t('searchAssistantListings')}
        searchLabel={t('search')}
        clearLabel={t('clear')}
        clearHref="/admin/assistants"
      />

      <MarketListingManagement
        categories={categories}
        listings={result.items}
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        q={q}
        baseHref="/admin/assistants"
      />
    </AdminPage>
  );
}
