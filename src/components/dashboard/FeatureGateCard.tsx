import Link from 'next/link';
import { Check } from 'lucide-react';

export function FeatureGateCard({
  kicker,
  badge,
  title,
  description,
  bullets,
  primaryLabel,
  primaryHref,
  secondaryLabel,
  secondaryHref,
}: {
  kicker: string;
  badge: string;
  title: string;
  description: string;
  bullets: string[];
  primaryLabel: string;
  primaryHref?: string;
  secondaryLabel?: string;
  secondaryHref?: string;
}) {
  return (
    <div className="mx-auto max-w-xl rounded-xl border border-zinc-200 bg-white p-7 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          {kicker}
        </span>
        <span className="rounded-full border border-zinc-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          {badge}
        </span>
      </div>
      <h2 className="mt-3 text-xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
        {title}
      </h2>
      <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">
        {description}
      </p>
      <ul className="mt-5 space-y-2.5">
        {bullets.map((b) => (
          <li key={b} className="flex items-start gap-2.5 text-sm text-zinc-700 dark:text-zinc-300">
            <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            {b}
          </li>
        ))}
      </ul>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        {primaryHref ? (
          <Link
            href={primaryHref}
            className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {primaryLabel}
          </Link>
        ) : (
          <button
            type="button"
            className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {primaryLabel}
          </button>
        )}
        {secondaryLabel ? (
          <Link
            href={secondaryHref ?? '#'}
            className="inline-flex h-9 items-center rounded-md border border-zinc-200 px-4 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            {secondaryLabel}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
