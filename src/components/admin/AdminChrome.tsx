"use client";

import type { ReactNode } from "react";
import { ChevronRight, Menu, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { LocaleSwitcher } from "@/components/layout/LocaleSwitcher";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { AdminSidebar, getAdminPageLabelKey } from "./AdminSidebar";
import { AnimatedSidebarTrigger } from "@/components/motion/animated-sidebar";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";
export function AdminChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/admin";
  const t = useTranslations("admin");
  const pageLabel = t(getAdminPageLabelKey(pathname));

  return (
    <WorkspaceShell
      className="h-dvh"
      sidebar={<AdminSidebar />}
      mobileHeader={
        <>
          <AnimatedSidebarTrigger aria-label={t("adminOpenMenu")}>
            <Menu className="size-5" aria-hidden="true" />
          </AnimatedSidebarTrigger>
          <Link
            href="/admin"
            className="flex items-center gap-2 text-sm font-semibold"
          >
            <ShieldCheck className="size-4" aria-hidden="true" />
            {t("adminConsoleTitle")}
          </Link>
        </>
      }
      header={
        <header className="flex items-center justify-between gap-3 px-4 py-2 lg:px-8">
          <p className="flex min-w-0 items-center gap-2 text-sm">
            <Link
              href="/admin"
              className="hidden shrink-0 items-center gap-2 text-muted-foreground hover:text-foreground sm:inline-flex"
            >
              <ShieldCheck className="size-4" aria-hidden="true" />
              {t("adminConsoleTitle")}
            </Link>
            <ChevronRight
              aria-hidden="true"
              className="hidden size-3.5 shrink-0 text-muted-foreground sm:inline-block"
            />
            <span className="truncate font-semibold">{pageLabel}</span>
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <LocaleSwitcher />
            <ThemeToggle />
          </div>
        </header>
      }
    >
      {children}
    </WorkspaceShell>
  );
}
