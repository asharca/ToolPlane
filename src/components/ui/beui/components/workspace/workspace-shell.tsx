"use client";

import type { ComponentPropsWithRef, ReactNode } from "react";
import {
  AnimatedSidebarProvider,
  type AnimatedSidebarProviderProps,
} from "../motion/animated-sidebar";
import { cn } from "../../lib/utils";

export interface WorkspaceShellProps extends AnimatedSidebarProviderProps {
  sidebar?: ReactNode;
  tabBar?: ReactNode;
  mobileHeader?: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  /** content: this pane scrolls; none: the editor/chat child owns scrolling. */
  scroll?: "content" | "none";
  contentProps?: Omit<ComponentPropsWithRef<"div">, "children">;
}

const hasSlot = (node: ReactNode) => node != null && typeof node !== "boolean";

/** The beUI sidebar provider owns navigation state; the host owns tabs and data.
 * Set a height on the shell. Tabs and content share one alignment line, and the
 * first active tab removes only the adjoining top-left corner of the surface.
 * data-workspace-shell identifies this composition without replacing beUI's
 * own data-slot="sidebar-wrapper" or introducing a second layout wrapper.
 */
export function WorkspaceShell({
  sidebar, tabBar, mobileHeader, header, footer, children, className, style,
  scroll = "content", contentProps, ...props
}: WorkspaceShellProps) {
  const sidebarInset = hasSlot(sidebar) && "lg:ml-[var(--workspace-gap,0px)]";
  return (
    <AnimatedSidebarProvider
      {...props}
      data-workspace-shell=""
      style={{ "--sidebar-width": "14rem", "--sidebar-width-icon": "4rem", ...style }}
      className={cn("h-full min-h-0 w-full overflow-hidden bg-[var(--workspace-shell-background,var(--muted))] text-foreground", className)}
    >
      {sidebar}
      <div data-slot="workspace-body" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {hasSlot(mobileHeader) && <div data-slot="workspace-mobile-header" className="flex h-12 shrink-0 items-center gap-2 px-2 lg:hidden">{mobileHeader}</div>}
        {hasSlot(tabBar) && <div data-slot="workspace-shell-tabs" className={cn("peer/workspace-tabs mx-[var(--workspace-gap,0.5rem)] min-w-0 shrink-0", sidebarInset)}>{tabBar}</div>}
        <div data-slot="workspace-surface" className={cn(
          "m-[var(--workspace-gap,0.5rem)] flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--workspace-radius,0.75rem)] bg-[var(--workspace-surface,var(--background))]",
          sidebarInset,
          hasSlot(tabBar) && "mt-0 peer-has-[[data-leading-active=true]]/workspace-tabs:rounded-tl-none",
        )}>
          {hasSlot(header) && <div data-slot="workspace-header" className="min-w-0 shrink-0">{header}</div>}
          <div {...contentProps} data-slot="workspace-content" data-scroll={scroll} className={cn("min-h-0 min-w-0 flex-1", scroll === "content" ? "overflow-auto overscroll-contain" : "flex flex-col overflow-hidden", contentProps?.className)}>{children}</div>
          {hasSlot(footer) && <div data-slot="workspace-footer" className="min-w-0 shrink-0">{footer}</div>}
        </div>
      </div>
    </AnimatedSidebarProvider>
  );
}

/** Invoke synchronously from a user action. null means the browser blocked it.
 * Only the host decides whether to remove a tab and what state may be copied.
 */
export function openWorkspaceWindow(href: string | URL, prepare?: (popup: Window) => void): Window | null {
  const url = new URL(href, window.location.href);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== window.location.origin || url.username || url.password) {
    throw new Error("工作区窗口必须使用不含凭据的同源 HTTP(S) 地址。");
  }
  const popup = window.open("about:blank", "_blank", "popup,width=1100,height=760");
  if (!popup) return null;
  try {
    popup.opener = null;
    prepare?.(popup);
    popup.location.replace(url.href);
    return popup;
  } catch (error) {
    popup.close();
    throw error;
  }
}
