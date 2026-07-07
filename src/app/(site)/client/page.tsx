import { getTranslations } from 'next-intl/server';
import { listClients } from '@/lib/queries/clients';
import { listCategories } from '@/lib/queries/categories';
import { ClientCard } from '@/components/cards/ClientCard';
import { ListingHero } from '@/components/ListingHero';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const t = await getTranslations('client');
  const [clients, categories] = await Promise.all([
    listClients(),
    listCategories(),
  ]);
  return (
    <div className="mx-auto max-w-screen-xl px-4">
      <ListingHero
        lead={t('browseAll')}
        tail={t('mcpClients')}
        subtitle={t('mcpClientsConnectAiAgentsToModelContextProtocolServers')}
        placeholder={t('searchForMcpClients')}
        categories={categories.map((c) => ({ slug: c.slug, name: c.name }))}
      />
      <div className="pb-14">
        {clients.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noClientsYet')}</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {clients.map((client) => (
              <ClientCard key={client.slug} client={client} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
