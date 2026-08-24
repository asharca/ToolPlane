import Link from 'next/link';
import { ArrowUpRight, Gauge, Star, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export interface EntityCardProps {
  href: string;
  name: string;
  description?: string | null;
  author?: string | null;
  iconUrl?: string | null;
  category?: string | null;
  stat?: ReactNode;
  rank?: number;
}

export function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

function MetricStat({
  value,
  label,
  icon: Icon,
}: {
  value: number;
  label: string;
  icon: LucideIcon;
}) {
  return (
    <span className="flex items-center text-xs font-medium text-muted-foreground">
      <Icon aria-hidden="true" className="mr-1 size-3 text-muted-foreground/80" />
      <span aria-hidden="true">{formatCount(value)}</span>
      <span className="sr-only">
        {label}: {value.toLocaleString()}
      </span>
    </span>
  );
}

export function StarStat({
  value,
  label = 'Stars',
}: {
  value: number;
  label?: string;
}) {
  return <MetricStat value={value} label={label} icon={Star} />;
}

export function ScoreStat({
  value,
  label = 'Score',
}: {
  value: number;
  label?: string;
}) {
  return <MetricStat value={value} label={label} icon={Gauge} />;
}

export function EntityCard({
  href,
  name,
  description,
  author,
  iconUrl,
  category,
  stat,
  rank,
}: EntityCardProps) {
  return (
    <Link href={href} className="group block h-full">
      <div className="ui-panel relative flex h-full flex-col overflow-hidden transition-[border-color,background-color] duration-200 group-hover:border-brand/30 group-hover:bg-card">
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand/0 to-transparent transition-colors group-hover:via-brand/45" />
        <div className="flex h-full flex-col p-4">
          {typeof rank === 'number' ? (
            <div className="mb-2.5">
              <span className="inline-flex items-center rounded-md bg-brand-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold text-brand">
                #{rank}
              </span>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2.5">
              {iconUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={iconUrl}
                  alt=""
                  width={32}
                  height={32}
                  loading="lazy"
                  decoding="async"
                  className="size-8 shrink-0 rounded-lg border border-border/70 object-cover"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="size-8 shrink-0 rounded-lg border border-brand/10 bg-brand-soft"
                />
              )}
              <div className="min-w-0">
                <h3 className="line-clamp-1 text-[15px] font-semibold text-foreground transition-colors group-hover:text-brand">
                  {name}
                </h3>
                {author ? (
                  <p className="truncate text-[11px] leading-4 text-muted-foreground">{author}</p>
                ) : null}
              </div>
            </div>
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground/50 transition-colors group-hover:bg-brand-soft group-hover:text-brand">
              <ArrowUpRight aria-hidden="true" className="size-3.5" />
            </span>
          </div>

          {description ? (
            <p className="mt-3 line-clamp-2 flex-1 text-[13px] leading-5 text-muted-foreground">
              {description}
            </p>
          ) : (
            <div className="flex-1" />
          )}

          {category || stat ? (
            <div className="mt-4 flex items-center justify-between gap-2 border-t border-border/70 pt-3">
              <div className="flex min-w-0 items-center gap-2">
                {category ? (
                  <span className="inline-flex max-w-full items-center truncate rounded-md bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground">
                    {category}
                  </span>
                ) : null}
              </div>
              {stat ? <div className="shrink-0">{stat}</div> : null}
            </div>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
