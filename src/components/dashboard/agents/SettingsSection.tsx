import { type ReactNode, useId } from "react";
import { cn } from "@/lib/utils";

/** One titled block of a settings page; `id` is the deep-link scroll target. */
export function SettingsSection({
  id,
  title,
  action,
  hidden,
  flush = false,
  className,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  hidden?: boolean;
  /** Children bring their own horizontal padding (standalone panels). */
  flush?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      hidden={hidden}
      data-settings-section={id}
      aria-labelledby={headingId}
      className={cn(
        "min-w-0 scroll-mt-4",
        flush ? "space-y-0" : "space-y-3",
        className,
      )}
    >
      <div
        className={cn(
          "flex min-h-8 items-center justify-between gap-3",
          flush && "px-6 pt-5",
        )}
      >
        <h3 id={headingId} className="text-sm font-semibold text-foreground">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}
