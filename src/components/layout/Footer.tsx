import Link from 'next/link';
import { Boxes } from 'lucide-react';
import { ThemeToggle } from '@/components/theme/ThemeToggle';

type FooterLink = { label: string; href: string };
type FooterColumn = { title: string; links: FooterLink[] };

const COLUMNS: FooterColumn[] = [
  {
    title: 'Browse',
    links: [
      { label: 'MCP Servers', href: '/server' },
      { label: 'MCP Clients', href: '/client' },
      { label: 'Agent Skills', href: '/tools/skills' },
      { label: 'Categories', href: '/categories' },
      { label: 'MCP Search', href: '/search' },
      { label: 'MCP Market Hub', href: '/hub' },
      { label: 'What is an MCP server?', href: '/what-is-an-mcp-server' },
      { label: 'Model Context Protocol', href: 'https://modelcontextprotocol.io' },
    ],
  },
  {
    title: 'Rankings',
    links: [
      { label: 'Top MCPs Today', href: '/daily' },
      { label: 'Top Agent Skills Today', href: '/daily/skills' },
      { label: 'Top 100 Agent Skills', href: '/tools/skills/leaderboard' },
      { label: 'Top 100 MCP Servers', href: '/leaderboards' },
    ],
  },
  {
    title: 'About',
    links: [
      { label: 'News', href: '/news' },
      { label: 'Submit', href: '/submit' },
      { label: 'Contact', href: 'mailto:support@mcpmarket.com' },
      { label: 'Privacy', href: '/privacy' },
      { label: 'Terms', href: '/terms' },
    ],
  },
];

function FooterItem({ link }: { link: FooterLink }) {
  const className =
    'text-sm text-muted-foreground transition-colors hover:text-foreground';
  const isExternal =
    link.href.startsWith('http') || link.href.startsWith('mailto:');

  if (isExternal) {
    return (
      <a href={link.href} className={className} rel="noopener noreferrer">
        {link.label}
      </a>
    );
  }
  return (
    <Link href={link.href} className={className}>
      {link.label}
    </Link>
  );
}

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto max-w-screen-xl px-4 py-12">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          <div className="col-span-2 md:col-span-1">
            <Link href="/" className="flex items-center gap-1.5 font-mono text-base">
              <Boxes className="size-5 text-foreground" />
              <span>
                <span className="font-bold text-foreground">MCP</span>
                <span className="font-normal text-muted-foreground"> Market</span>
              </span>
            </Link>
            <p className="mt-3 max-w-xs text-sm text-muted-foreground">
              Discover MCP servers that connect MCP clients like Claude and Cursor
              to your favorite tools. Browse the MCP Market to get started.
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.title}>
              <h4 className="mb-3 text-sm font-semibold text-foreground">
                {col.title}
              </h4>
              <ul className="space-y-2">
                {col.links.map((link) => (
                  <li key={link.href}>
                    <FooterItem link={link} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-col-reverse items-start justify-between gap-4 border-t border-border pt-6 sm:flex-row sm:items-center">
          <p className="text-xs text-muted-foreground">
            © {year} MCP Market. All rights reserved.{' · '}
            <Link href="/privacy" className="hover:text-foreground">
              Privacy
            </Link>
            {' · '}
            <Link href="/terms" className="hover:text-foreground">
              Terms
            </Link>
          </p>
          <ThemeToggle />
        </div>
      </div>
    </footer>
  );
}
