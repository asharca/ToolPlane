import Link from 'next/link';
import { ThemeToggle } from '@/components/theme/ThemeToggle';

export function Header() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-[57px] max-w-screen-xl items-center justify-between px-4">
        <Link
          href="/"
          className="font-mono text-base font-semibold tracking-tight text-foreground"
        >
          MCPMarket
        </Link>

        <nav className="flex items-center gap-1 sm:gap-2">
          <Link
            href="/sell"
            className="hidden px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
          >
            Sell Skills
          </Link>
          <Link
            href="/hub"
            className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Connect
          </Link>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
