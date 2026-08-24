import Link from 'next/link';
import { Code2, Menu, X } from 'lucide-react';
import { getLocale } from 'next-intl/server';
import { getMarketingContent } from '@/lib/marketing/content';
import { SITE } from '@/lib/site';
import { Logo } from './Logo';
import { LocaleSwitcher } from './LocaleSwitcher';

export async function Header() {
  const locale = await getLocale();
  const { navigation } = getMarketingContent(locale);

  return (
    <header className="sticky top-0 z-50 w-full bg-shell/90 px-2 py-2 backdrop-blur-xl supports-[backdrop-filter]:bg-shell/75 sm:px-3">
      <div className="mx-auto flex h-12 max-w-[96rem] items-center justify-between rounded-xl border border-border/80 bg-card px-2.5 sm:px-3">
        <div className="flex min-w-0 items-center gap-5 lg:gap-7">
          <Link href="/" aria-label="ToolPlane" className="group flex items-center">
            <Logo svgSize={28} wordmarkClass="text-lg" />
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {navigation.links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="inline-flex min-h-8 items-center rounded-lg px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-1 sm:gap-2">
          <div className="hidden md:block">
            <LocaleSwitcher />
          </div>
          <a
            href={SITE.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground lg:inline-flex"
          >
            <Code2 aria-hidden="true" className="size-3.5" />
            {navigation.sourceCode}
          </a>
          <Link href="/app" className="ui-button-primary ui-button-sm">
            {navigation.openConsole}
          </Link>
          <details className="group relative md:hidden">
            <summary
              role="button"
              aria-label={navigation.menu}
              className="ui-button-ghost ui-icon-button flex cursor-pointer list-none [&::-webkit-details-marker]:hidden"
            >
              <Menu aria-hidden="true" className="size-5 group-open:hidden" />
              <X aria-hidden="true" className="hidden size-5 group-open:block" />
            </summary>
            <div className="absolute right-0 top-[calc(100%+0.75rem)] w-64 rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-xl">
              <nav aria-label={navigation.menu} className="grid gap-1">
                {navigation.links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="flex min-h-11 items-center rounded-lg px-3 text-sm font-medium transition-colors hover:bg-accent"
                  >
                    {link.label}
                  </Link>
                ))}
                <a
                  href={SITE.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors hover:bg-accent"
                >
                  <Code2 aria-hidden="true" className="size-4" />
                  {navigation.sourceCode}
                </a>
              </nav>
              <div className="mt-2 border-t border-border pt-2">
                <LocaleSwitcher />
              </div>
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}
