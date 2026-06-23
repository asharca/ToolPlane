import Link from 'next/link';
import { Boxes, ChevronDown, Zap } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';

export async function Header() {
  const user = await getCurrentUser();

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-[57px] max-w-screen-xl items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="flex items-center gap-1.5 font-mono text-base tracking-tight"
          >
            <Boxes className="size-5 text-foreground" />
            <span>
              <span className="font-bold text-foreground">MCP</span>
              <span className="font-normal text-muted-foreground"> Market</span>
            </span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            <Link
              href="/server"
              className="inline-flex items-center gap-1 px-2 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              MCP Servers
              <ChevronDown className="size-3.5" />
            </Link>
            <Link
              href="/tools/skills"
              className="inline-flex items-center gap-1 px-2 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Agent Skills
              <ChevronDown className="size-3.5" />
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-1 sm:gap-2">
          <Link
            href="/sell"
            className="hidden px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
          >
            Sell Skills
          </Link>
          {user ? (
            <Link
              href="/account"
              className="hidden px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
            >
              Account
            </Link>
          ) : (
            <Link
              href="/login"
              className="hidden px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
            >
              Sign in
            </Link>
          )}
          <Link
            href="/hub"
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Zap className="size-4" />
            Power Your Agents
          </Link>
        </div>
      </div>
    </header>
  );
}
