import type { Metadata } from 'next';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getHubServers } from '@/lib/hub/queries';
import { removeFromHubAction } from '@/lib/hub/actions';
import { HubConnect } from '@/components/hub/HubConnect';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'MCP Market Hub | Power Your Agents',
};

function Landing() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-20 text-center">
      <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
        MCP Market Hub
      </h1>
      <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground">
        Power your agents — connect to hundreds of MCP servers through a single
        gateway with one API token.
      </p>
      <div className="mt-8 flex justify-center gap-3">
        <Link
          href="/signup"
          className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Get started
        </Link>
        <Link
          href="/login"
          className="inline-flex h-10 items-center rounded-md border border-border px-5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          Sign in
        </Link>
      </div>
    </div>
  );
}

export default async function Page() {
  const user = await getCurrentUser();
  if (!user) return <Landing />;

  const servers = await getHubServers(user.id);
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const endpoint = `${base}/api/v1/hub`;

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-4 py-10">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Your Hub
        </h1>
        <p className="text-sm text-muted-foreground">
          {servers.length} connected{' '}
          {servers.length === 1 ? 'server' : 'servers'}
        </p>
      </header>

      <HubConnect endpoint={endpoint} />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">
          Connected servers
        </h2>
        {servers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No servers yet.{' '}
            <Link href="/server" className="font-medium text-foreground underline">
              Browse servers
            </Link>{' '}
            and add them to your Hub.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {servers.map((server) => (
              <li
                key={server.id}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <Link
                    href={`/server/${server.slug}`}
                    className="truncate text-sm font-medium text-foreground hover:underline"
                  >
                    {server.name}
                  </Link>
                  {server.author ? (
                    <p className="truncate text-xs text-muted-foreground">
                      {server.author}
                    </p>
                  ) : null}
                </div>
                <form action={removeFromHubAction}>
                  <input type="hidden" name="serverId" value={server.id} />
                  <button
                    type="submit"
                    className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                  >
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
