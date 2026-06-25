import Link from 'next/link';
import { Globe } from 'lucide-react';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { Logo } from './Logo';

type FooterLink = { label: string; href: string };

const BROWSE: FooterLink[] = [
  { label: 'MCP Search', href: '/search' },
  { label: 'MCP Servers', href: '/server' },
  { label: 'MCP Clients', href: '/client' },
  { label: 'Agent Skills', href: '/tools/skills' },
  { label: 'Categories', href: '/categories' },
  { label: 'What is an MCP server?', href: '/what-is-an-mcp-server' },
  { label: 'Model Context Protocol', href: 'https://modelcontextprotocol.io' },
];

const RANKINGS: FooterLink[] = [
  { label: 'Top MCPs Today', href: '/daily' },
  { label: 'Top Agent Skills Today', href: '/daily/skills' },
  { label: 'Top 100 Agent Skills', href: '/tools/skills/leaderboard' },
  { label: 'Top 100 MCP Servers', href: '/leaderboards' },
];

const ABOUT: FooterLink[] = [
  { label: 'News', href: '/news' },
  { label: 'Submit', href: '/submit' },
  { label: 'Contact', href: 'mailto:support@mcpmarket.com' },
];

const itemClass =
  'text-sm text-muted-foreground transition-colors hover:text-foreground';

function FooterItem({ link }: { link: FooterLink }) {
  const isExternal =
    link.href.startsWith('http') || link.href.startsWith('mailto:');
  if (isExternal) {
    return (
      <a href={link.href} className={itemClass} rel="noopener noreferrer">
        {link.label}
      </a>
    );
  }
  return (
    <Link href={link.href} className={itemClass}>
      {link.label}
    </Link>
  );
}

function Column({ title, links }: { title: string; links: FooterLink[] }) {
  return (
    <div>
      <h4 className="mb-4 font-mono text-xs font-semibold uppercase tracking-wider text-foreground">
        {title}
      </h4>
      <ul className="space-y-3">
        {links.map((link) => (
          <li key={link.href}>
            <FooterItem link={link} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border bg-card">
      <div className="w-full px-6 lg:px-8">
        <div className="mx-auto max-w-7xl py-12 md:py-16">
          <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-5 lg:gap-10">
            <div className="md:col-span-2">
              <Link href="/" className="group mb-4 flex items-center gap-2">
                <Logo wordmarkClass="text-xl" />
              </Link>
              <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                Discover MCP servers that connect MCP clients like Claude and
                Cursor to your favorite tools. Browse the MCP Market to get
                started.
              </p>
            </div>

            <Column title="Browse" links={BROWSE} />
            <Column title="Rankings" links={RANKINGS} />
            <Column title="About" links={ABOUT} />
          </div>

          <div className="mt-8 flex flex-col items-center justify-between gap-4 border-t border-border pt-6 md:mt-12 md:flex-row md:pt-8">
            <div className="order-2 flex items-center gap-2 md:order-1">
              <button
                type="button"
                aria-label="Switch language"
                className="inline-flex h-8 w-8 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Globe className="size-4" />
              </button>
              <ThemeToggle />
            </div>
            <p className="order-1 font-mono text-xs text-muted-foreground md:order-2">
              © {year} MCP Market. All rights reserved.
              <span className="mx-1.5">·</span>
              <Link
                href="/privacy"
                className="transition-colors hover:text-foreground"
              >
                Privacy
              </Link>
              <span className="mx-1.5">·</span>
              <Link
                href="/terms"
                className="transition-colors hover:text-foreground"
              >
                Terms
              </Link>
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
