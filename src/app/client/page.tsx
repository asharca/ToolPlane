import { listClients } from '@/lib/queries/clients';
import { ClientCard } from '@/components/cards/ClientCard';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const clients = await listClients();
  return (
    <div className="mx-auto max-w-screen-xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-bold tracking-tight text-foreground">
        Browse All MCP Clients
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {clients.length.toLocaleString()} clients
      </p>
      {clients.length === 0 ? (
        <p className="text-sm text-muted-foreground">No clients yet.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {clients.map((client) => (
            <ClientCard key={client.slug} client={client} />
          ))}
        </div>
      )}
    </div>
  );
}
