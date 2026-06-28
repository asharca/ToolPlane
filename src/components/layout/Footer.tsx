import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { Logo } from './Logo';

type FooterLink = { labelKey: string; href: string };

const BROWSE: FooterLink[] = [
  { labelKey: 'mcpSearch', href: '/search' },
  { labelKey: 'mcpServers', href: '/server' },
  { labelKey: 'mcpClients', href: '/client' },
  { labelKey: 'agentSkills', href: '/tools/skills' },
  { labelKey: 'categories', href: '/categories' },
  { labelKey: 'whatIsMcp', href: '/what-is-an-mcp-server' },
  { labelKey: 'mcp', href: 'https://modelcontextprotocol.io' },
];

const RANKINGS: FooterLink[] = [
  { labelKey: 'topMcpsToday', href: '/daily' },
  { labelKey: 'topSkillsToday', href: '/daily/skills' },
  { labelKey: 'top100Skills', href: '/tools/skills/leaderboard' },
  { labelKey: 'top100Servers', href: '/leaderboards' },
];

const ABOUT: FooterLink[] = [
  { labelKey: 'news', href: '/news' },
  { labelKey: 'submit', href: '/submit' },
  { labelKey: 'contact', href: 'mailto:support@mcpmarket.com' },
];

const itemClass =
  'text-sm text-muted-foreground transition-colors hover:text-foreground';

function FooterItem({
  link,
  label,
}: {
  link: FooterLink;
  label: string;
}) {
  const isExternal =
    link.href.startsWith('http') || link.href.startsWith('mailto:');
  if (isExternal) {
    return (
      <a href={link.href} className={itemClass} rel="noopener noreferrer">
        {label}
      </a>
    );
  }
  return (
    <Link href={link.href} className={itemClass}>
      {label}
    </Link>
  );
}

function Column({
  title,
  links,
  tLinks,
}: {
  title: string;
  links: FooterLink[];
  tLinks: (key: string) => string;
}) {
  return (
    <div>
      <h4 className="mb-4 font-mono text-xs font-semibold uppercase tracking-wider text-foreground">
        {title}
      </h4>
      <ul className="space-y-3">
        {links.map((link) => (
          <li key={link.href}>
            <FooterItem link={link} label={tLinks(link.labelKey)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Footer() {
  const t = useTranslations('footer');
  const tLinks = useTranslations('footer.links');

  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto max-w-7xl px-6 py-12 lg:px-8">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          <div className="col-span-2 md:col-span-1">
            <Logo />
          </div>
          <Column title={t('browse')} links={BROWSE} tLinks={tLinks} />
          <Column title={t('rankings')} links={RANKINGS} tLinks={tLinks} />
          <Column title={t('about')} links={ABOUT} tLinks={tLinks} />
        </div>
        <div className="mt-8 flex items-center justify-between border-t border-border pt-8">
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} MCP Market
          </p>
          <ThemeToggle />
        </div>
      </div>
    </footer>
  );
}
