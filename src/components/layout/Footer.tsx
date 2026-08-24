import Link from 'next/link';
import { getLocale } from 'next-intl/server';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { getMarketingContent } from '@/lib/marketing/content';
import { SITE } from '@/lib/site';
import { Logo } from './Logo';

type FooterLink = {
  label: string;
  href: string;
};

const itemClass =
  'inline-flex min-h-8 items-center text-[13px] text-muted-foreground transition-colors hover:text-brand';

function FooterItem({ link }: { link: FooterLink }) {
  const external = link.href.startsWith('http');
  if (external) {
    return (
      <a
        href={link.href}
        className={itemClass}
        target="_blank"
        rel="noopener noreferrer"
      >
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
      <h2 className="mb-2.5 text-xs font-semibold text-foreground">
        {title}
      </h2>
      <ul className="space-y-1">
        {links.map((link) => (
          <li key={link.href}>
            <FooterItem link={link} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export async function Footer() {
  const locale = await getLocale();
  const content = getMarketingContent(locale);
  const { footer, navigation } = content;
  const productLinks = navigation.links.filter((link) => link.href !== '/');
  const resourceLinks: FooterLink[] = [
    { label: footer.sourceCode, href: SITE.sourceUrl },
    { label: footer.mcpProtocol, href: SITE.protocolUrl },
    { label: footer.documentation, href: '/what-is-an-mcp-server' },
  ];
  const accessLinks: FooterLink[] = [
    { label: footer.openConsole, href: '/app' },
    { label: footer.signIn, href: '/app/login' },
  ];

  return (
    <footer className="px-2 pb-2 pt-8 sm:px-3 sm:pb-3">
      <div className="mx-auto max-w-[96rem] rounded-xl border border-border/80 bg-card px-5 py-7 sm:px-7">
        <div className="grid grid-cols-2 gap-7 md:grid-cols-4">
          <div className="col-span-2 md:col-span-1">
            <Logo svgSize={28} wordmarkClass="text-lg" />
            <p className="mt-3 max-w-xs text-[13px] leading-5 text-muted-foreground">
              {footer.tagline}
            </p>
          </div>
          <Column title={footer.product} links={productLinks} />
          <Column title={footer.resources} links={resourceLinks} />
          <Column title={footer.access} links={accessLinks} />
        </div>
        <div className="mt-7 flex flex-col items-center justify-between gap-3 border-t border-border pt-4 md:flex-row">
          <div className="order-2 md:order-1">
            <ThemeToggle />
          </div>
          <p className="order-1 text-xs text-muted-foreground md:order-2">
            © {new Date().getFullYear()} {SITE.name}. {footer.rights}
            <span className="mx-1.5">·</span>
            <Link href="/privacy" className="inline-flex min-h-8 items-center transition-colors hover:text-foreground">
              {footer.privacy}
            </Link>
            <span className="mx-1.5">·</span>
            <Link href="/terms" className="inline-flex min-h-8 items-center transition-colors hover:text-foreground">
              {footer.terms}
            </Link>
          </p>
        </div>
      </div>
    </footer>
  );
}
