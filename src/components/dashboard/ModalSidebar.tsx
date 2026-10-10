"use client";

import type { ReactNode } from "react";

export function ModalSidebar({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <aside
      className={`shrink-0 border-b border-border/60 bg-muted/20 md:min-h-0 md:w-52 md:border-b-0 md:border-r ${className}`}
    >
      {children}
    </aside>
  );
}
