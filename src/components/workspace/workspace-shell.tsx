"use client";
// asharca.github.io/ui/components/blocks/workspace-shell

import type { ComponentPropsWithRef, ReactNode } from "react";
import {
  AnimatedSidebarProvider,
  type AnimatedSidebarProviderProps,
} from "@/components/motion/animated-sidebar";
import { cn } from "@/lib/utils";

export interface WorkspaceShellProps extends AnimatedSidebarProviderProps {
  sidebar?: ReactNode;
  mobileHeader?: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  /** content: this pane scrolls; none: the editor/chat child owns scrolling. */
  scroll?: "content" | "none";
  contentProps?: Omit<ComponentPropsWithRef<"div">, "children">;
}

const hasSlot = (node: ReactNode) => node != null && typeof node !== "boolean";

/** The beUI sidebar provider owns navigation state; the host owns data.
 * Set a height on the shell. data-workspace-shell identifies this composition
 * without replacing beUI's own data-slot="sidebar-wrapper" or introducing a
 * second layout wrapper.
 */
export function WorkspaceShell({
  sidebar,
  mobileHeader,
  header,
  footer,
  children,
  className,
  style,
  scroll = "content",
  contentProps,
  ...props
}: WorkspaceShellProps) {
  const sidebarInset = hasSlot(sidebar) && "md:ml-[var(--workspace-gap,0px)]";
  return (
    <AnimatedSidebarProvider
      {...props}
      data-workspace-shell=""
      style={{
        "--sidebar-width": "15rem",
        "--sidebar-width-icon": "4rem",
        ...style,
      }}
      className={cn(
        "h-full min-h-0 w-full overflow-hidden bg-[var(--workspace-shell-background,var(--muted))] text-foreground",
        className,
      )}
    >
      {sidebar}
      <div
        data-slot="workspace-body"
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {hasSlot(mobileHeader) && (
          <div
            data-slot="workspace-mobile-header"
            className="flex h-12 shrink-0 items-center gap-2 px-2 md:hidden"
          >
            {mobileHeader}
          </div>
        )}
        <div
          data-slot="workspace-surface"
          className={cn(
            "m-[var(--workspace-gap,0.5rem)] flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--workspace-radius,0.75rem)] bg-[var(--workspace-surface,var(--background))]",
            sidebarInset,
          )}
        >
          {hasSlot(header) && (
            <div data-slot="workspace-header" className="min-w-0 shrink-0">
              {header}
            </div>
          )}
          <div
            {...contentProps}
            data-slot="workspace-content"
            data-scroll={scroll}
            className={cn(
              "min-h-0 min-w-0 flex-1",
              scroll === "content"
                ? "overflow-auto overscroll-contain"
                : "flex flex-col overflow-hidden",
              contentProps?.className,
            )}
          >
            {children}
          </div>
          {hasSlot(footer) && (
            <div data-slot="workspace-footer" className="min-w-0 shrink-0">
              {footer}
            </div>
          )}
        </div>
      </div>
    </AnimatedSidebarProvider>
  );
}
