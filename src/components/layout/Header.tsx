import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { FaGithub } from 'react-icons/fa';
import { getTranslations } from 'next-intl/server';
import { SITE } from '@/lib/site';
import { Logo } from './Logo';
import { LocaleSwitcher } from './LocaleSwitcher';

export async function Header() {
  const t = await getTranslations('header');

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-card/90 backdrop-blur-sm supports-[backdrop-filter]:bg-card/80">
      <div className="w-full px-4 sm:px-6 lg:px-8">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between">
          <div className="flex min-w-0 items-center gap-8">
            <Link href="/" aria-label="ToolPlane" className="group flex items-center gap-2">
              <Logo wordmarkClass="text-xl sm:text-2xl" />
            </Link>

            <nav className="hidden items-center gap-1 md:flex">
              <Link
                href="/server"
                className="inline-flex items-center gap-1 px-2 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {t('mcpServers')}
              </Link>
              <Link
                href="/tools/skills"
                className="inline-flex items-center gap-1 px-2 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {t('agentSkills')}
              </Link>
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
              className="hidden items-center gap-1.5 px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground lg:inline-flex"
            >
              <FaGithub className="size-4" />
              {t('sourceCode')}
            </a>
            <Link
              href="/app"
              className="ui-button-secondary"
            >
              {t('dashboard')}
            </Link>
            <details className="group relative md:hidden">
              <summary
                role="button"
                aria-label={t('menu')}
                className="ui-button-ghost ui-icon-button flex cursor-pointer list-none [&::-webkit-details-marker]:hidden"
              >
                <Menu className="size-5 group-open:hidden" />
                <X className="hidden size-5 group-open:block" />
              </summary>
              <div className="absolute right-0 top-[calc(100%+0.5rem)] w-64 rounded-md border border-border bg-popover p-2 text-popover-foreground">
                <nav aria-label={t('menu')} className="grid gap-1">
                  <Link
                    href="/server"
                    className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium hover:bg-muted"
                  >
                    {t('mcpServers')}
                  </Link>
                  <Link
                    href="/tools/skills"
                    className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium hover:bg-muted"
                  >
                    {t('agentSkills')}
                  </Link>
                  <a
                    href={SITE.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-medium hover:bg-muted"
                  >
                    <FaGithub className="size-4" />
                    {t('sourceCode')}
                  </a>
                </nav>
                <div className="mt-2 border-t border-border pt-2">
                  <LocaleSwitcher />
                </div>
              </div>
            </details>
          </div>
        </div>
      </div>
    </header>
  );
}
