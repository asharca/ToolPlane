import Link from 'next/link';
import { Star, ArrowUpRight } from 'lucide-react';
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

export function StarStat({ value }: { value: number }) {
  return (
    <div className="flex items-center font-mono text-xs text-muted-foreground">
      <Star className="mr-1 h-3 w-3 fill-muted-foreground/30 text-muted-foreground" />
      {formatCount(value)}
    </div>
  );
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
      <div className="ui-panel relative h-full transition-colors duration-200 group-hover:border-brand/50 group-hover:bg-accent/40">
        <div className="p-5">
          {typeof rank === 'number' ? (
            <div className="mb-3">
              <span className="inline-flex items-center rounded border border-border px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">
                #{rank}
              </span>
            </div>
          ) : null}

          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2.5">
              {iconUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={iconUrl}
                  alt={author ?? name}
                  width={20}
                  height={20}
                  loading="lazy"
                  className="size-5 shrink-0 rounded-full object-cover opacity-50 grayscale transition-all duration-200 group-hover:opacity-100 group-hover:grayscale-0"
                />
              ) : (
                <div className="size-5 shrink-0 rounded-full bg-muted" />
              )}
              <h3 className="line-clamp-1 text-base font-semibold text-foreground transition-colors group-hover:text-foreground/80">
                {name}
              </h3>
            </div>
            <ArrowUpRight className="mt-0.5 size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground/60" />
          </div>

          {description ? (
            <p className="mb-4 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}

          {category || stat ? (
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                {category ? (
                  <span className="inline-flex max-w-full items-center truncate rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
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
