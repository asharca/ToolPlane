"use client";

import Link from "next/link";
import { Menu } from "lucide-react";
import { FaGithub } from "react-icons/fa";
import { useLocale } from "next-intl";
import { getMarketingContent } from "@/lib/marketing/content";
import { SITE } from "@/lib/site";
import { Logo } from "./Logo";
import { LocaleSwitcher } from "./LocaleSwitcher";
import { Button, ButtonLink } from "@/components/motion/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/motion/popover";

export function Header() {
  const locale = useLocale();
  const { navigation } = getMarketingContent(locale);

  return (
    <header className="sticky top-0 z-50 w-full px-2 py-2 sm:px-3">
      <div className="mx-auto flex h-12 max-w-[96rem] items-center justify-between rounded-xl border border-border/60 bg-card/60 px-2.5 shadow-sm backdrop-blur-xl sm:px-3">
        <div className="flex min-w-0 items-center gap-5 lg:gap-7">
          <Link
            href="/"
            aria-label="ToolPlane"
            className="group flex items-center"
          >
            <Logo svgSize={28} wordmarkClass="text-lg" />
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {navigation.links.map((link) => (
              <ButtonLink
                key={link.href}
                href={link.href}
                variant="ghost"
                size="sm"
              >
                {link.label}
              </ButtonLink>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-1 sm:gap-2">
          <div className="hidden md:block">
            <LocaleSwitcher />
          </div>
          <ButtonLink
            href={SITE.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            variant="ghost"
            size="sm"
            className="hidden lg:inline-flex"
          >
            <FaGithub aria-hidden="true" className="size-3.5" />
            {navigation.sourceCode}
          </ButtonLink>
          <ButtonLink href="/app" size="sm">
            {navigation.openConsole}
          </ButtonLink>
          <Popover align="end" className="md:hidden">
            <PopoverTrigger>
              <Button variant="ghost" size="icon" aria-label={navigation.menu}>
                <Menu aria-hidden="true" className="size-5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent>
              <nav aria-label={navigation.menu} className="grid gap-1">
                {navigation.links.map((link) => (
                  <ButtonLink key={link.href} href={link.href} variant="ghost">
                    {link.label}
                  </ButtonLink>
                ))}
                <ButtonLink
                  href={SITE.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="ghost"
                >
                  <FaGithub aria-hidden="true" className="size-4" />
                  {navigation.sourceCode}
                </ButtonLink>
              </nav>
              <div className="mt-2 border-t border-border pt-2">
                <LocaleSwitcher />
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </header>
  );
}
