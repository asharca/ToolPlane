"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Menu } from "lucide-react";
import { useTranslations } from "next-intl";
import { DashboardSidebar } from "./DashboardSidebar";
import type { WorkspaceCreationQuota } from "./WorkspaceForms";
import { DashboardLogo } from "./DashboardLogo";
import { DashboardRuntimeConfigProvider } from "./DashboardRuntimeConfig";
import { Toaster } from "./Toaster";
import { usePersistentBoolean } from "@/lib/use-persistent-boolean";
import { dashboardSidebarCookieName } from "@/lib/sidebar-preferences";
import {
  hasUnsavedWorkspaceChanges,
  lastWorkspaceCookieName,
} from "@/lib/workspace/navigation";
import { AnimatedSidebarTrigger } from "@/components/motion/animated-sidebar";
import {
  ConfirmActionDialog,
  hasOpenDialog,
} from "@/components/dashboard/ConversationUxPrimitives";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";

type Workspace = { id: string; slug: string; name: string };

type PendingNavigation =
  | { kind: "href"; href: string }
  | { kind: "form"; form: HTMLFormElement };

export function DashboardChrome({
  slug,
  userId,
  workspaceId,
  workspaceName,
  userLabel,
  workspaces,
  quota,
  supportEmail,
  isAdmin = false,
  initialSidebarCollapsed = false,
  children,
}: {
  slug: string;
  userId?: string;
  workspaceId: string;
  workspaceName: string;
  userLabel: string;
  workspaces: Workspace[];
  quota: WorkspaceCreationQuota;
  supportEmail: string;
  isAdmin?: boolean;
  initialSidebarCollapsed?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = usePersistentBoolean(
    `toolplane:dashboard-sidebar:${slug}`,
    initialSidebarCollapsed,
    dashboardSidebarCookieName(workspaceId),
  );
  const [isMediumViewport, setIsMediumViewport] = useState(false);
  const [mdExpanded, setMdExpanded] = useState(false);
  const [pendingNav, setPendingNav] = useState<PendingNavigation | null>(null);
  const bypassFormRef = useRef<HTMLFormElement | null>(null);
  const router = useRouter();
  const t = useTranslations("console.sidebar");
  const workspaceT = useTranslations("console.workspaces");
  const commonT = useTranslations("common");
  const pathname = usePathname() ?? "";
  const workspaceBase = `/app/${slug}/`;
  const activeSegment = pathname.startsWith(workspaceBase)
    ? pathname.slice(workspaceBase.length).split("/")[0]
    : "";
  const isDualSidebarRoute =
    activeSegment === "chat" ||
    activeSegment === "work" ||
    activeSegment === "agents";
  const useMdAutoCollapse = isMediumViewport && isDualSidebarRoute;
  const effectiveOpen = useMdAutoCollapse ? mdExpanded : !collapsed;
  const setEffectiveCollapsed = (nextCollapsed: boolean) => {
    if (useMdAutoCollapse) setMdExpanded(!nextCollapsed);
    else setCollapsed(nextCollapsed);
  };

  useEffect(() => {
    const media = window.matchMedia(
      "(min-width: 768px) and (max-width: 1023px)",
    );
    const sync = () => {
      setIsMediumViewport(media.matches);
      if (!media.matches) setMdExpanded(false);
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const mobilePageTitle = (() => {
    switch (activeSegment) {
      case "chat":
        return t("chat");
      case "agents":
      case "work":
        return t("agents");
      case "mcp":
        return t("mcpServers");
      case "skills":
        return t("skills");
      case "plugins":
        return t("plugins");
      case "knowledge":
        return t("knowledge");
      case "providers":
        return t("modelProviders");
      case "sandboxes":
        return t("sandboxes");
      case "observability":
        return t("observability");
      case "members":
        return t("members");
      case "notifications":
        return t("notifications");
      case "feedback":
        return t("feedback");
      case "files":
        return t("files");
      case "settings":
        return t("settings");
      default:
        return null;
    }
  })();

  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link =
        event.target instanceof Element ? event.target.closest("a") : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download"))
        return;
      const target = new URL(link.href, location.href);
      if (
        target.origin === location.origin &&
        target.pathname.startsWith(`/app/${slug}/`)
      )
        return;
      if (hasUnsavedWorkspaceChanges()) {
        event.preventDefault();
        event.stopPropagation();
        setPendingNav({
          kind: "href",
          href:
            target.origin === location.origin
              ? `${target.pathname}${target.search}${target.hash}`
              : target.href,
        });
      }
    };
    const submit = (event: SubmitEvent) => {
      if (
        !(event.target instanceof HTMLFormElement) ||
        !event.target.hasAttribute("data-workspace-navigation")
      )
        return;
      if (bypassFormRef.current === event.target) {
        bypassFormRef.current = null;
        return;
      }
      if (hasUnsavedWorkspaceChanges(document, event.target)) {
        event.preventDefault();
        event.stopPropagation();
        setPendingNav({ kind: "form", form: event.target });
      }
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (hasUnsavedWorkspaceChanges()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    document.addEventListener("click", click, true);
    document.addEventListener("submit", submit, true);
    window.addEventListener("beforeunload", unload);
    return () => {
      document.removeEventListener("click", click, true);
      document.removeEventListener("submit", submit, true);
      window.removeEventListener("beforeunload", unload);
    };
  }, [slug]);

  useEffect(() => {
    if (!userId) return;
    // biome-ignore lint/suspicious/noDocumentCookie: Persist synchronously on HTTP development origins and browsers without Cookie Store support.
    document.cookie = `${lastWorkspaceCookieName(userId)}=${encodeURIComponent(slug)}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  }, [slug, userId]);

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
      if (useMdAutoCollapse) setMdExpanded((prev) => !prev);
      else setCollapsed(!collapsed);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [collapsed, setCollapsed, useMdAutoCollapse]);

  return (
    <DashboardRuntimeConfigProvider supportEmail={supportEmail}>
      <WorkspaceShell
        className="h-dvh [--dashboard-page-header-height:2.75rem]"
        open={effectiveOpen}
        onOpenChange={(expanded) => setEffectiveCollapsed(!expanded)}
        openMobile={open}
        onOpenMobileChange={setOpen}
        scroll="none"
        sidebar={
          <DashboardSidebar
            slug={slug}
            workspaceName={workspaceName}
            userLabel={userLabel}
            workspaces={workspaces}
            quota={quota}
            isAdmin={isAdmin}
          />
        }
        mobileHeader={
          <>
            <AnimatedSidebarTrigger aria-label={t("openMenu")}>
              <Menu aria-hidden="true" className="size-5" />
            </AnimatedSidebarTrigger>
            <DashboardLogo />
            <span aria-hidden="true" className="text-border">
              /
            </span>
            <span className="max-w-28 truncate text-xs font-medium text-muted-foreground">
              {workspaceName}
            </span>
            {mobilePageTitle ? (
              <>
                <span aria-hidden="true" className="text-border">
                  /
                </span>
                <span className="min-w-0 truncate text-sm font-medium text-foreground">
                  {mobilePageTitle}
                </span>
              </>
            ) : null}
          </>
        }
      >
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto overscroll-contain [scrollbar-width:thin] [scrollbar-color:color-mix(in_srgb,var(--foreground)_18%,transparent)_transparent] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-foreground/20">
          {children}
        </main>
      </WorkspaceShell>
      <ConfirmActionDialog
        open={pendingNav !== null}
        title={commonT("unsavedChanges")}
        description={workspaceT("unsavedChanges")}
        confirmLabel={commonT("confirm")}
        cancelLabel={commonT("cancel")}
        destructive
        onClose={() => setPendingNav(null)}
        onConfirm={() => {
          const target = pendingNav;
          setPendingNav(null);
          if (!target) return;
          if (target.kind === "href") {
            if (target.href.startsWith("/")) router.push(target.href);
            else window.location.assign(target.href);
          } else {
            bypassFormRef.current = target.form;
            target.form.requestSubmit();
          }
        }}
      />
      <Toaster />
    </DashboardRuntimeConfigProvider>
  );
}
