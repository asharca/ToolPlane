"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";

type LiveItem = {
  id?: string;
  taskId?: string;
  createdAt?: string;
  startedAt?: string;
};

/** Pausing freezes the table, not the connection, so arrivals remain countable. */
export function LiveToggle<T extends LiveItem>({
  url,
  onItems,
  onPausedChange,
}: {
  url: string;
  onItems: (items: T[]) => void;
  onPausedChange?: (paused: boolean) => void;
}) {
  const [paused, setPaused] = useState(false);
  const [count, setCount] = useState(0);
  const [connected, setConnected] = useState(false);
  const pausedRef = useRef(false);
  const pending = useRef(new Map<string, T>());
  const callback = useRef(onItems);
  callback.current = onItems;

  useEffect(() => {
    pending.current.clear();
    setCount(0);
    setConnected(false);
    // EventSource preserves the server's keyset Last-Event-ID across reconnects.
    const source = new EventSource(url);
    source.onopen = () => setConnected(true);
    source.addEventListener("item", (event: MessageEvent<string>) => {
      let item: T;
      try {
        item = JSON.parse(event.data) as T;
      } catch {
        return;
      }
      const id = item.id ?? item.taskId;
      if (!id) return;
      if (pausedRef.current) {
        pending.current.set(id, item);
        setCount(pending.current.size);
      } else callback.current([item]);
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [url]);

  function toggle() {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    onPausedChange?.(next);
    if (!next) {
      callback.current(Array.from(pending.current.values()));
      pending.current.clear();
      setCount(0);
    }
  }
  return (
    <LiveControls
      paused={paused}
      count={count}
      connected={connected}
      onToggle={toggle}
    />
  );
}

export function LiveControls({
  paused,
  count = 0,
  connected = true,
  onToggle,
}: {
  paused: boolean;
  count?: number;
  connected?: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations("console.observability.viewer");
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span role="status" className="text-muted-foreground">
        {connected ? t("live") : t("reconnecting")}
      </span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onToggle}
        aria-pressed={paused}
      >
        {t(paused ? "resume" : "pause")}
      </Button>
      {paused && count > 0 && (
        <span
          className="rounded-full bg-primary/10 px-2 py-1 text-primary"
          aria-live="polite"
        >
          {t("newItems", { count })}
        </span>
      )}
    </div>
  );
}
