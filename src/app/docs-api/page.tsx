import { BookOpen } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { LocaleSwitcher } from "@/components/layout/LocaleSwitcher";
import { Logo } from "@/components/layout/Logo";
import { ButtonLink } from "@/components/motion/button";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { getMarketingContent } from "@/lib/marketing/content";
import { SITE } from "@/lib/site";
import { Reference } from "./reference";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const { navigation } = getMarketingContent(locale);
  return {
    title: `${navigation.apiReference} | ${SITE.name}`,
    description: "Interactive ToolPlane OpenAPI reference.",
  };
}

export default async function ApiReferencePage() {
  const [locale, messages, common] = await Promise.all([
    getLocale(),
    getMessages(),
    getTranslations("common"),
  ]);
  const { navigation } = getMarketingContent(locale);

  return (
    <NextIntlClientProvider messages={{ common: messages.common }}>
      <div className="isolate flex min-h-dvh flex-col bg-background text-foreground">
        <a
          href="#api-reference-main"
          className="sr-only fixed left-3 top-3 z-[100] rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-lg focus:not-sr-only"
        >
          {common("skipToContent")}
        </a>

        <header className="sticky top-0 z-40 border-b border-border bg-card/80 backdrop-blur-xl">
          <div className="mx-auto flex h-12 max-w-[96rem] items-center justify-between gap-3 px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-2.5">
              <Link
                href="/"
                aria-label={SITE.name}
                className="group flex shrink-0 items-center"
              >
                <Logo svgSize={26} wordmarkClass="text-base" />
              </Link>
              <span aria-hidden="true" className="text-border-strong">
                /
              </span>
              <span className="truncate font-mono text-xs font-medium text-muted-foreground">
                {navigation.apiReference}
              </span>
            </div>

            <nav
              aria-label={navigation.apiReference}
              className="flex shrink-0 items-center gap-1.5"
            >
              <LocaleSwitcher />
              <ThemeToggle />
              <ButtonLink
                href={navigation.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                variant="ghost"
                size="sm"
                className="hidden whitespace-nowrap sm:inline-flex"
              >
                <BookOpen aria-hidden="true" className="size-3.5" />
                {navigation.docs}
              </ButtonLink>
              <ButtonLink href="/app" size="sm" className="whitespace-nowrap">
                {navigation.openConsole}
              </ButtonLink>
            </nav>
          </div>
        </header>

        <main id="api-reference-main" className="flex-1">
          <Reference locale={locale} />
        </main>
      </div>
    </NextIntlClientProvider>
  );
}
