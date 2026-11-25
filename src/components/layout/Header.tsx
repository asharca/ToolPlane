"use client";

import { BookOpen, FileCode2, Menu } from "lucide-react";
import Link from "next/link";
import { useLocale } from "next-intl";
import { useState } from "react";
import { GithubIcon } from "@/components/ui/GithubIcon";
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
  const [menuOpen, setMenuOpen] = useState(false);

  function closeMenu() {
    setMenuOpen(false);
  }

  return (
    <header className="sticky top-0 z-50 w-full px-4 py-2 sm:px-6 lg:px-8">
      <div className="mx-auto flex h-12 max-w-6xl items-center justify-between gap-2 rounded-xl border border-border/60 bg-card/75 px-3 shadow-sm backdrop-blur-xl sm:px-4">
        <div className="flex min-w-0 items-center gap-4 lg:gap-5">
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
          <div className="hidden items-center gap-1 lg:flex">
            <LocaleSwitcher />
            <ButtonLink
              href={navigation.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="ghost"
              size="sm"
              className="whitespace-nowrap"
            >
              <BookOpen aria-hidden="true" className="size-3.5" />
              {navigation.docs}
            </ButtonLink>
            <ButtonLink
              href={SITE.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="ghost"
              size="icon"
              aria-label={navigation.sourceCode}
              title={navigation.sourceCode}
            >
              <GithubIcon aria-hidden="true" className="size-4" />
            </ButtonLink>
          </div>
          <ButtonLink href="/app" size="sm" className="whitespace-nowrap">
            {navigation.openConsole}
          </ButtonLink>
          <Popover
            open={menuOpen}
            onOpenChange={setMenuOpen}
            align="end"
            className="lg:hidden"
          >
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
                    className="justify-start"
                    onClick={closeMenu}
                  >
                    {link.label}
                  </ButtonLink>
                ))}
                <ButtonLink
                  href="/docs-api"
                  variant="ghost"
                  className="justify-start"
                  onClick={closeMenu}
                >
                  <FileCode2 aria-hidden="true" className="size-4" />
                  {navigation.apiReference}
                </ButtonLink>
                <ButtonLink
                  href={navigation.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="ghost"
                  className="justify-start"
                  onClick={closeMenu}
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
                  onClick={closeMenu}
                >
                  <GithubIcon aria-hidden="true" className="size-4" />
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
