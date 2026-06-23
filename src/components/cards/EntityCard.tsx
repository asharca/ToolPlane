import Link from 'next/link';
import { Star } from 'lucide-react';
import type { ReactNode } from 'react';

export interface EntityCardProps {
  href: string;
  name: string;
  description?: string | null;
  author?: string | null;
  iconUrl?: string | null;
  stat?: ReactNode;
}

export function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

export function StarStat({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Star className="size-3.5" />
      {formatCount(value)}
    </span>
  );
}

export function EntityCard({
  href,
  name,
  description,
  author,
  iconUrl,
  stat,
}: EntityCardProps) {
  return (
    <Link href={href} className="group block">
      <div className="relative h-full rounded-lg border border-border bg-card transition-colors duration-200 hover:border-foreground/20 hover:bg-accent/50">
        <div className="p-5">
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
              {author ? (
                <span className="truncate text-xs text-muted-foreground">
                  {author}
                </span>
              ) : null}
            </div>
            {stat ? <div className="shrink-0">{stat}</div> : null}
          </div>

          <h3 className="line-clamp-1 font-mono text-base font-semibold text-foreground">
            {name}
          </h3>
          {description ? (
            <p className="mb-4 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
