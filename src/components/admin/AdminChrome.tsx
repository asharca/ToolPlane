"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Menu, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { LocaleSwitcher } from "@/components/layout/LocaleSwitcher";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { AdminSidebar, getAdminPageLabelKey } from "./AdminSidebar";
import { AnimatedSidebarTrigger } from "@/components/motion/animated-sidebar";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";
import { hasOpenDialog } from "@/components/dashboard/ConversationUxPrimitives";
import { Toaster } from "@/components/dashboard/Toaster";
import { usePersistentBoolean } from "@/lib/use-persistent-boolean";

export function AdminChrome({
  userLabel,
  children,
}: {
  userLabel?: string;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "/admin";
  const t = useTranslations("admin");
  const pageLabel = t(getAdminPageLabelKey(pathname));
  const [openMobile, setOpenMobile] = useState(false);
  const [collapsed, setCollapsed] = usePersistentBoolean(
    "toolplane:admin-sidebar",
    false,
  );
  const segments = pathname.split("/").filter(Boolean);
  const isDetailRoute = segments.length > 2;
  const sectionHref =
    segments.length >= 2 ? `/${segments[0]}/${segments[1]}` : "/admin";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey ||
        event.key !== "\\" ||
        event.isComposing
      ) {
        return;
      }
      if (hasOpenDialog()) return;
      event.preventDefault();
      setCollapsed(!collapsed);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [collapsed, setCollapsed]);

  return (
    <>
      <WorkspaceShell
        className="h-dvh"
        open={!collapsed}
        onOpenChange={(expanded) => setCollapsed(!expanded)}
        openMobile={openMobile}
        onOpenMobileChange={setOpenMobile}
        sidebar={<AdminSidebar userLabel={userLabel} />}
        mobileHeader={
          <>
            <AnimatedSidebarTrigger aria-label={t("adminOpenMenu")}>
              <Menu className="size-5" aria-hidden="true" />
            </AnimatedSidebarTrigger>
            <Link
              href="/admin"
              className="flex min-w-0 items-center gap-2 truncate text-sm font-semibold"
            >
              <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{t("adminConsoleTitle")}</span>
            </Link>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <LocaleSwitcher />
              <ThemeToggle />
            </div>
          </>
        }
        header={
          <header className="hidden items-center justify-between gap-3 px-4 py-2 md:flex lg:px-8">
            <p className="flex min-w-0 items-center gap-2 text-sm">
              <Link
                href="/admin"
                className="inline-flex shrink-0 items-center gap-2 text-muted-foreground hover:text-foreground"
              >
                <ShieldCheck className="size-4" aria-hidden="true" />
                {t("adminConsoleTitle")}
              </Link>
              {isDetailRoute ? (
                <>
                  <ChevronRight
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <Link
                    href={sectionHref}
                    className="truncate font-medium text-muted-foreground hover:text-foreground"
                  >
                    {pageLabel}
                  </Link>
                </>
              ) : null}
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
      <Toaster />
    </>
  );
}
