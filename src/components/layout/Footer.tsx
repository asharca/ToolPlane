import Link from 'next/link';

type FooterLink = { label: string; href: string };
type FooterColumn = { title: string; links: FooterLink[] };

const COLUMNS: FooterColumn[] = [
  {
    title: 'MCP',
    links: [
      { label: 'MCP Search', href: '/search' },
      { label: 'MCP Servers', href: '/server' },
      { label: 'MCP Clients', href: '/client' },
      { label: 'Agent Skills', href: '/tools/skills' },
      { label: 'MCP Market Hub', href: '/hub' },
    ],
  },
  {
    title: 'Browse',
    links: [
      { label: 'Categories', href: '/categories' },
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
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <h3 className="mb-3 text-sm font-semibold text-foreground">
                {col.title}
              </h3>
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
        <p className="mt-10 text-xs text-muted-foreground">
          © {year} MCPMarket
        </p>
      </div>
    </footer>
  );
}
