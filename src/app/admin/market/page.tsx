import Link from 'next/link';
import { ClipboardCheck } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { AdminPage, AdminPageHeader, AdminSearchForm } from '@/components/admin/AdminUI';
import { MarketCatalogManagement } from '@/components/admin/MarketCatalogManagement';
import { listCategories } from '@/lib/admin/categories';
import { listAdminMarketListings, listAdminPublicToolkits } from '@/lib/admin/market-catalog';
import { requireAdmin } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';

export default async function AdminMarketPage({ searchParams = Promise.resolve({}) }: {
  searchParams?: Promise<{ q?: string; listingPage?: string; toolkitPage?: string }>;
} = {}) {
  await requireAdmin();
  const [t, ops, query] = await Promise.all([getTranslations('admin'), getTranslations('adminOps'), searchParams]);
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 200) : '';
  const [listings, toolkits, categories] = await Promise.all([
    listAdminMarketListings({ page: Number(query.listingPage), q }),
    listAdminPublicToolkits({ page: Number(query.toolkitPage), q }), listCategories(),
  ]);
  return <AdminPage>
    <AdminPageHeader title={ops('catalog')} meta={t('marketAdministrationCount', { listings: listings.total, toolkits: toolkits.total })}
      actions={<Link href="/admin/reviews" className="ui-button-secondary"><ClipboardCheck className="size-4" />{ops('reviewQueue')}</Link>} />
    <AdminSearchForm defaultValue={q} placeholder={t('marketCatalogSearchPlaceholder')} label={t('marketCatalogSearchLabel')} searchLabel={t('search')} clearLabel={t('clear')} clearHref="/admin/market" />
    <MarketCatalogManagement categories={categories} listings={listings.items} toolkits={toolkits.items}
      listingPage={listings.page} listingPageSize={listings.pageSize} listingTotal={listings.total}
      toolkitPage={toolkits.page} toolkitPageSize={toolkits.pageSize} toolkitTotal={toolkits.total} q={q} />
  </AdminPage>;
}
