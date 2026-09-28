
import { ButtonLink } from '@/components/motion/button';
import type { ReactNode } from 'react';

import { AnimatedBadge } from '@/components/motion/animated-badge';
import { ArrowLeft, PackageCheck } from 'lucide-react';

type DetailTag = {
  label: string;
  href?: string;
};

export function MarketDetailHeader({
  backHref,
  backLabel,
  iconUrl,
  icon,
  type,
  title,
  summary,
  publisher,
  facts,
  tags = [],
}: {
  backHref: string;
  backLabel: string;
  iconUrl?: string | null;
  icon?: ReactNode;
  type: string;
  title: string;
  summary?: string | null;
  publisher?: string | null;
  facts: { label: string; value: ReactNode }[];
  tags?: DetailTag[];
}) {
  return (
    <header>
      <ButtonLink
        href={backHref}
        variant="ghost" size="sm"
      >
        <ArrowLeft className="size-3.5" /> {backLabel}
      </ButtonLink>
      <div className="mt-5 flex flex-col gap-5 sm:flex-row sm:items-start">
        {iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={iconUrl} alt="" width={72} height={72} className="size-[4.5rem] rounded-lg object-cover" />
        ) : (
          <span className="flex size-[4.5rem] shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            {icon ?? <PackageCheck className="size-7" />}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <AnimatedBadge status="info" size="sm">{type}</AnimatedBadge>
          <h1 className="mt-2 text-2xl font-semibold text-foreground sm:text-3xl">{title}</h1>
          {publisher ? <p className="mt-1.5 text-xs text-muted-foreground">{publisher}</p> : null}
          {summary ? <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">{summary}</p> : null}
          <dl className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
            {facts.map((fact) => (
              <div key={fact.label} className="inline-flex items-center gap-1.5">
                <dt>{fact.label}</dt>
                <dd className="font-medium text-foreground">{fact.value}</dd>
              </div>
            ))}
          </dl>
          {tags.length ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {tags.map((tag) => tag.href ? (
                <ButtonLink
                  key={`${tag.href}:${tag.label}`}
                  href={tag.href}
                  variant="ghost" size="sm"
                >
                  {tag.label}
                </ButtonLink>
              ) : (
                <AnimatedBadge key={tag.label} status="neutral" size="sm">
                  {tag.label}
                </AnimatedBadge>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

export function MarketDetailShell({
  navigationLabel,
  tabs,
  children,
  aside,
}: {
  navigationLabel: string;
  tabs: { href: string; label: string }[];
  children: ReactNode;
  aside: ReactNode;
}) {
  return (
    <>
      <nav aria-label={navigationLabel} className="flex gap-5 overflow-x-auto border-b border-border/60">
        {tabs.map((tab, index) => (
          <a
            key={tab.href}
            href={tab.href}
            className={`shrink-0 border-b-2 px-0.5 py-3 text-sm font-medium ${
              index === 0
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </a>
        ))}
      </nav>
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <main className="min-w-0 space-y-8">{children}</main>
        <aside className="space-y-5 xl:sticky xl:top-20 xl:self-start">{aside}</aside>
      </div>
    </>
  );
}
