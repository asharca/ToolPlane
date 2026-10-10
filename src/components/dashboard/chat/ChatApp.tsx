"use client";

import type { ButtonHTMLAttributes } from "react";
import { useEffect, useRef } from "react";
import {
  AnimatedSidebarProvider,
  type AnimatedSidebarProviderProps,
  useAnimatedSidebar,
  AnimatedSidebarTrigger,
} from "@/components/motion/animated-sidebar";
import { cn } from "@/lib/utils";

const MIN_DOCKED_WIDTH = 600;

export interface ChatAppProps extends AnimatedSidebarProviderProps {
  sidebarWidth?: string;
  collapseSidebarBelow?: number;
}

function ShellFit({ minWidth }: { minWidth: number }) {
  const { open, setOpen } = useAnimatedSidebar();
  const markerRef = useRef<HTMLDivElement>(null);
  const narrowRef = useRef<boolean | null>(null);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const shell = markerRef.current?.parentElement;
    if (!shell) return;
    const observer = new ResizeObserver(([entry]) => {
      const narrow = entry.contentRect.width < minWidth;
      if (narrowRef.current === narrow) return;
      const first = narrowRef.current === null;
      narrowRef.current = narrow;
      if (first && !narrow) return;
      const wanted = !narrow;
      if (openRef.current !== wanted) setOpen(wanted);
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, [minWidth, setOpen]);

  return <div ref={markerRef} className="hidden" />;
}

export function ChatApp({
  children,
  className,
  sidebarWidth = "17rem",
  collapseSidebarBelow = MIN_DOCKED_WIDTH,
  style,
  ...props
}: ChatAppProps) {
  return (
    <AnimatedSidebarProvider
      {...props}
      style={{ ...style, "--sidebar-width": sidebarWidth }}
      className={cn("min-h-0 w-full overflow-hidden bg-background", className)}
    >
      {props.open === undefined ? (
        <ShellFit minWidth={collapseSidebarBelow} />
      ) : null}
      {children}
    </AnimatedSidebarProvider>
  );
}

export function ChatAppSidebarTrigger({
  openLabel,
  closeLabel,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  openLabel: string;
  closeLabel: string;
}) {
  const { isMobile, open, openMobile } = useAnimatedSidebar();
  const label = (isMobile ? openMobile : open) ? closeLabel : openLabel;

  return (
    <AnimatedSidebarTrigger
      {...props}
      aria-label={label}
      title={label}
      className={cn(
        "size-8 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
    />
  );
}
