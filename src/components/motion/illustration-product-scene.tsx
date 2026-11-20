"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { BatteryMedium, Wifi } from "lucide-react";
import { cn } from "@/lib/utils";

/** Shared illustration canvas; captions describe host contracts without painting demo chrome. */
export function ProductScene({
  children,
  title,
  caption,
  className,
  phone = false,
}: {
  children: ReactNode;
  title: string;
  caption?: string;
  className?: string;
  phone?: boolean;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        "@container relative isolate aspect-[4/3] w-full max-w-xl overflow-hidden rounded-2xl bg-muted text-foreground",
        className,
      )}
    >
      <h3 className="sr-only">{title}</h3>
      {phone ? (
        <>
          <div className="absolute bottom-[-25%] left-1/2 h-[108%] w-[58%] -translate-x-1/2 rounded-t-[2.15rem] border border-border bg-background/70 p-1.5">
            <div className="relative h-full overflow-y-auto rounded-t-[1.8rem] border border-border bg-background px-[8%] text-[max(8px,1.7cqw)] [scrollbar-width:none] [&>header>div>p]:text-[max(7.36px,1.56cqw)] [&>header_h4]:text-[max(15.04px,3.2cqw)] [&>header_h4]:leading-normal [&>header_h4]:tracking-tight">
              <div
                aria-hidden="true"
                className="mb-[10%] flex items-center justify-between pt-[5%] text-[8px] font-semibold"
              >
                <span>9:41</span>
                <span className="flex items-center gap-0.5">
                  <Wifi className="size-2.5" />
                  <BatteryMedium className="size-3" />
                </span>
              </div>
              {children}
            </div>
          </div>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[18%] bg-gradient-to-t from-muted to-transparent"
          />
        </>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center p-[9%]">
          <div className="w-full rounded-2xl border border-border bg-background p-[6%] shadow-sm">
            {children}
          </div>
        </div>
      )}
      {caption && <p className="sr-only">{caption}</p>}
    </section>
  );
}

/** Host callbacks are the only source of asynchronous results. No timers or simulated success. */
export function useProductRequest<T>() {
  const [result, setResult] = useState<T | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function run(action: () => Promise<T>) {
    if (active.current) return;
    active.current = true;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const next = await action();
      if (mounted.current) setResult(next);
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The action could not be completed. Try again.",
        );
    } finally {
      active.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return { result, pending, error, run };
}

export function SceneError({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="mt-3 text-sm text-destructive">
      {message}
    </p>
  ) : null;
}

/** Presentation-only checkpoints: this never invokes a host action or creates a request result. */
export function useIllustrationSequence(
  enabled: boolean,
  checkpoints: readonly number[],
  duration: number,
) {
  const [frame, setFrame] = useState(0);
  const current = Math.min(frame, checkpoints.length - 1);
  useEffect(() => {
    if (!enabled || checkpoints.length < 2) return;
    const next = (current + 1) % checkpoints.length;
    const delay = next
      ? checkpoints[next] - checkpoints[current]
      : duration - checkpoints[current];
    const timer = window.setTimeout(() => setFrame(next), delay);
    return () => window.clearTimeout(timer);
  }, [enabled, checkpoints, duration, current]);
  return current;
}

export function IllustrationPlaybackControl({
  playing,
  onPlayingChange,
  label,
  reduced,
}: {
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  label: string;
  reduced?: boolean | null;
}) {
  return (
    <button
      type="button"
      disabled={!!reduced}
      aria-label={`${playing ? "Pause" : "Play"} ${label}`}
      aria-pressed={playing && !reduced}
      onClick={() => onPlayingChange(!playing)}
      className="absolute bottom-1 right-1 z-50 cursor-pointer rounded-full bg-background/95 px-3 py-2 text-[1.8cqw] opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 disabled:cursor-default"
    >
      {reduced ? "Motion reduced" : `Demo · ${playing ? "Pause" : "Play"}`}
    </button>
  );
}
