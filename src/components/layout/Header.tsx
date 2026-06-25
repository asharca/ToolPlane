import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { Logo } from './Logo';

export async function Header() {
  const user = await getCurrentUser();

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-background/95 backdrop-blur-sm supports-[backdrop-filter]:bg-background/80">
      <div className="w-full px-6 lg:px-8">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between">
          <div className="flex items-center gap-8">
            <Link href="/" className="group flex items-center gap-2">
              <Logo hideWordmarkOnMobile />
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
            <Link
              href={user ? '/app' : '/app/login'}
              className="inline-flex h-9 items-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              {user ? 'Dashboard' : 'Sign in'}
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}
