import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getCurrentUser } from '@/lib/auth/current-user';
import { listApiTokens } from '@/lib/auth/tokens';
import { logoutAction } from '@/lib/auth/actions';
import { TokenManager, type TokenView } from '@/components/account/TokenManager';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Account | MCP Market' };

function isoDate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export default async function Page() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const tokens = await listApiTokens(user.id);
  const view: TokenView[] = tokens.map((t) => ({
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    lastUsedAt: isoDate(t.lastUsedAt),
    createdAt: isoDate(t.createdAt) ?? '',
  }));

  return (
    <div className="mx-auto max-w-2xl space-y-10 px-4 py-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Account
          </h1>
          <p className="text-sm text-muted-foreground">
            {user.name ? `${user.name} · ` : ''}
            {user.email}
          </p>
        </div>
        <form action={logoutAction}>
          <button
            type="submit"
            className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Sign out
          </button>
        </form>
      </header>

      <TokenManager tokens={view} />

      <p className="text-sm text-muted-foreground">
        Manage your connected servers in the{' '}
        <Link href="/hub" className="font-medium text-foreground underline">
          Hub
        </Link>
        .
      </p>
    </div>
  );
}
