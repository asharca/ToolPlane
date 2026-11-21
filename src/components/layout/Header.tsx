"use client";

import { BookOpen, Menu } from "lucide-react";
import Link from "next/link";
import { useLocale } from "next-intl";
import { FaGithub } from "react-icons/fa";
import { Button, ButtonLink } from "@/components/motion/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/motion/popover";
import { getMarketingContent } from "@/lib/marketing/content";
import { SITE } from "@/lib/site";
import { LocaleSwitcher } from "./LocaleSwitcher";
import { Logo } from "./Logo";

export function Header() {
  const locale = useLocale();
  const { navigation } = getMarketingContent(locale);

  return (
    <header className="sticky top-0 z-50 w-full px-2 py-2 sm:px-3">
      <div className="mx-auto flex h-12 max-w-[96rem] items-center justify-between gap-2 rounded-xl border border-border/60 bg-card/70 px-2.5 shadow-sm backdrop-blur-xl sm:px-3">
        <div className="flex min-w-0 items-center gap-4 lg:gap-6">
          <Link
            href="/"
            aria-label="ToolPlane"
            className="group flex shrink-0 items-center"
          >
            <Logo svgSize={28} wordmarkClass="text-lg" />
          </Link>

          <nav
            aria-label={navigation.menu}
            className="hidden items-center gap-0.5 lg:flex"
          >
            {navigation.links.map((link) => (
              <ButtonLink
                key={link.href}
                href={link.href}
                variant="ghost"
                size="sm"
                className="whitespace-nowrap"
              >
                {link.label}
              </ButtonLink>
            ))}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
          <div className="hidden md:block">
            <LocaleSwitcher />
          </div>
          <ButtonLink
            href={navigation.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            variant="ghost"
            size="sm"
            className="hidden whitespace-nowrap xl:inline-flex"
          >
            <BookOpen aria-hidden="true" className="size-3.5" />
            {navigation.docs}
          </ButtonLink>
          <ButtonLink
            href={SITE.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            variant="ghost"
            size="sm"
            className="hidden whitespace-nowrap xl:inline-flex"
          >
            <FaGithub aria-hidden="true" className="size-3.5" />
            {navigation.sourceCode}
          </ButtonLink>
          <ButtonLink href="/app" size="sm" className="whitespace-nowrap">
            {navigation.openConsole}
          </ButtonLink>
          <Popover align="end" className="xl:hidden">
            <PopoverTrigger>
              <Button variant="ghost" size="icon" aria-label={navigation.menu}>
                <Menu aria-hidden="true" className="size-5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent>
              <nav aria-label={navigation.menu} className="grid gap-1">
                {navigation.links.map((link) => (
                  <ButtonLink
                    key={link.href}
                    href={link.href}
                    variant="ghost"
                    className="justify-start lg:hidden"
                  >
                    {link.label}
                  </ButtonLink>
                ))}
                <ButtonLink
                  href={navigation.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="ghost"
                  className="justify-start"
                >
                  <BookOpen aria-hidden="true" className="size-4" />
                  {navigation.docs}
                </ButtonLink>
                <ButtonLink
                  href={SITE.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="ghost"
                  className="justify-start"
                >
                  <FaGithub aria-hidden="true" className="size-4" />
                  {navigation.sourceCode}
                </ButtonLink>
              </nav>
              <div className="mt-2 border-t border-border pt-2 md:hidden">
                <LocaleSwitcher />
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </header>
  );
}
