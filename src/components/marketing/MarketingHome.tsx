import Link from 'next/link';
import {
  ArrowRight,
  Bot,
  Boxes,
  Check,
  Eye,
  Layers3,
  LockKeyhole,
  Network,
  PackageCheck,
  ServerCog,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';
import type {
  MarketingCapability,
  MarketingContent,
} from '@/lib/marketing/content';

const VALUE_ICONS = [ShieldCheck, Layers3, Eye, UsersRound] as const;
const CAPABILITY_ICONS = {
  mcp: ServerCog,
  skills: PackageCheck,
  agents: Bot,
  clients: Network,
} satisfies Record<MarketingCapability, typeof Bot>;
const CAPABILITY_LINKS: Array<{
  key: MarketingCapability;
  href: string;
}> = [
  { key: 'mcp', href: '/server' },
  { key: 'skills', href: '/tools/skills' },
  { key: 'agents', href: '/agents' },
  { key: 'clients', href: '/client' },
];

export function MarketingHome({ content }: { content: MarketingContent }) {
  const { home, capabilities } = content;

  return (
    <div className="overflow-hidden">
      <section className="relative border-b border-border">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_70%_20%,hsl(var(--brand)/0.13),transparent_36%),linear-gradient(to_bottom,transparent,hsl(var(--muted)/0.35))]" />
        <div className="relative mx-auto max-w-7xl px-6 py-20 sm:py-28 lg:px-8 lg:py-32">
          <div className="max-w-4xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1 font-mono text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <span className="size-2 rounded-full bg-brand" />
              {home.eyebrow}
            </div>
            <h1 className="mt-7 text-balance text-5xl font-semibold tracking-[-0.055em] text-foreground sm:text-7xl lg:text-[5.4rem] lg:leading-[0.98]">
              {home.title}
            </h1>
            <p className="mt-7 max-w-2xl text-pretty text-lg leading-8 text-muted-foreground sm:text-xl">
              {home.description}
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link href="/app" className="ui-button-primary min-h-11 px-5">
                {home.primaryAction}
                <ArrowRight className="size-4" />
              </Link>
              <Link href="#architecture" className="ui-button-secondary min-h-11 px-5">
                {home.secondaryAction}
              </Link>
            </div>
            <ul className="mt-9 flex flex-wrap gap-x-6 gap-y-3 text-sm text-muted-foreground">
              {home.trustPoints.map((point) => (
                <li key={point} className="flex items-center gap-2">
                  <Check className="size-4 text-brand" />
                  {point}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-20 lg:px-8 lg:py-28">
        <div className="max-w-3xl">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-brand">
            {home.valueEyebrow}
          </p>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-[-0.035em] sm:text-5xl">
            {home.valueTitle}
          </h2>
        </div>
        <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
          {home.values.map((value, index) => {
            const Icon = VALUE_ICONS[index] ?? Boxes;
            return (
              <article key={value.title} className="bg-card p-7 sm:p-9">
                <span className="flex size-10 items-center justify-center rounded-lg bg-brand-soft text-accent-foreground">
                  <Icon className="size-5" />
                </span>
                <h3 className="mt-6 text-lg font-semibold">{value.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {value.description}
                </p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="border-y border-border bg-muted/35">
        <div className="mx-auto max-w-7xl px-6 py-20 lg:px-8 lg:py-28">
          <div className="max-w-3xl">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-brand">
              {home.capabilityEyebrow}
            </p>
            <h2 className="mt-3 text-balance text-3xl font-semibold tracking-[-0.035em] sm:text-5xl">
              {home.capabilityTitle}
            </h2>
          </div>
          <div className="mt-12 grid gap-4 md:grid-cols-2">
            {CAPABILITY_LINKS.map(({ key, href }) => {
              const item = capabilities[key];
              const Icon = CAPABILITY_ICONS[key];
              return (
                <Link
                  key={key}
                  href={href}
                  className="group flex min-h-52 flex-col rounded-xl border border-border bg-card p-7 transition-colors hover:border-brand/45 hover:bg-background sm:p-8"
                >
                  <div className="flex items-start justify-between gap-4">
                    <Icon className="size-6 text-brand" />
                    <ArrowRight className="size-5 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-foreground" />
                  </div>
                  <h3 className="mt-8 text-xl font-semibold">{item.eyebrow}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {item.summary}
                  </p>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      <section id="architecture" className="mx-auto max-w-7xl scroll-mt-20 px-6 py-20 lg:px-8 lg:py-28">
        <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(22rem,0.95fr)] lg:gap-20">
          <div>
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-brand">
              {home.architectureEyebrow}
            </p>
            <h2 className="mt-3 text-balance text-3xl font-semibold tracking-[-0.035em] sm:text-5xl">
              {home.architectureTitle}
            </h2>
            <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground">
              {home.architectureDescription}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card p-6 sm:p-8">
            <div className="mb-7 flex items-center gap-3 border-b border-border pb-5">
              <span className="flex size-10 items-center justify-center rounded-lg bg-foreground text-background">
                <LockKeyhole className="size-5" />
              </span>
              <div className="h-2 w-28 rounded-full bg-muted" />
            </div>
            <ul className="space-y-5">
              {home.architecturePoints.map((point) => (
                <li key={point} className="flex gap-3 text-sm leading-6 text-foreground">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
                  {point}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="border-t border-border">
        <div className="mx-auto max-w-7xl px-6 py-20 lg:px-8 lg:py-24">
          <div className="rounded-2xl bg-foreground px-7 py-12 text-background sm:px-12 lg:flex lg:items-center lg:justify-between lg:gap-12">
            <div className="max-w-2xl">
              <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
                {home.closingTitle}
              </h2>
              <p className="mt-4 text-sm leading-6 text-background/70 sm:text-base">
                {home.closingDescription}
              </p>
            </div>
            <Link
              href="/app"
              className="mt-7 inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-background px-5 text-sm font-semibold text-foreground transition-opacity hover:opacity-90 lg:mt-0"
            >
              {home.closingAction}
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
