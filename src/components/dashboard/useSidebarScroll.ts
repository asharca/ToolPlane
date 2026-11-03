"use client";

import { useEffect, useRef, type UIEvent } from "react";

/** Reveal the native thumb while scrolling; keep its gutter stable when idle. */
export function useSidebarScroll() {
  const timeout = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(timeout.current);
    },
    [],
  );

  return (event: UIEvent<HTMLDivElement>) => {
    const viewport = event.currentTarget;
    viewport.dataset.scrolling = "true";
    window.clearTimeout(timeout.current);
    timeout.current = window.setTimeout(() => {
      delete viewport.dataset.scrolling;
      timeout.current = undefined;
    }, 800);
  };
}
