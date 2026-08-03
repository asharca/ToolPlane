import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CheckCircle2,
  Network,
  PackageCheck,
  ServerCog,
} from 'lucide-react';
import type {
  MarketingCapability,
  MarketingContent,
} from '@/lib/marketing/content';

const ICONS = {
  mcp: ServerCog,
  skills: PackageCheck,
  agents: Bot,
  clients: Network,
} satisfies Record<MarketingCapability, typeof Bot>;

export function CapabilityPage({
  capability,
  content,
}: {
  capability: MarketingCapability;
  content: MarketingContent;
}) {
  const page = content.capabilities[capability];
  const common = content.capabilityCommon;
  const Icon = ICONS[capability];

  return (
    <div>
      <section className="border-b border-border bg-[linear-gradient(to_bottom,hsl(var(--muted)/0.42),transparent)]">
        <div className="mx-auto max-w-7xl px-6 py-16 sm:py-24 lg:px-8">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            {common.overview}
          </Link>
          <div className="mt-12 max-w-4xl">
            <span className="flex size-12 items-center justify-center rounded-xl bg-brand-soft text-accent-foreground">
              <Icon className="size-6" />
            </span>
            <p className="mt-7 font-mono text-xs font-semibold uppercase tracking-[0.18em] text-brand">
              {page.eyebrow}
            </p>
            <h1 className="mt-3 text-balance text-4xl font-semibold tracking-[-0.045em] sm:text-6xl">
              {page.title}
            </h1>
            <p className="mt-6 max-w-2xl text-pretty text-lg leading-8 text-muted-foreground">
              {page.description}
            </p>
            <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
              <Link href="/app" className="ui-button-primary min-h-11 px-5">
                {common.openConsole}
                <ArrowRight className="size-4" />
              </Link>
              <span className="text-xs text-muted-foreground">{common.consoleNote}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-16 lg:px-8 lg:py-24">
        <div className="grid gap-5 md:grid-cols-3">
          {page.highlights.map((highlight, index) => (
            <article key={highlight.title} className="rounded-xl border border-border bg-card p-7">
              <span className="font-mono text-xs font-semibold text-brand">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h2 className="mt-6 text-lg font-semibold">{highlight.title}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {highlight.description}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="border-y border-border bg-muted/35">
        <div className="mx-auto grid max-w-7xl gap-12 px-6 py-16 lg:grid-cols-2 lg:px-8 lg:py-24">
          <div>
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-brand">
              {common.howItWorks}
            </p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
              {page.flowTitle}
            </h2>
            <ol className="mt-8 space-y-5">
              {page.flow.map((step, index) => (
                <li key={step} className="flex items-center gap-4 text-sm font-medium">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-card font-mono text-xs text-muted-foreground">
                    {index + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </div>
          <aside className="rounded-xl border border-border bg-card p-7 sm:p-9">
            <CheckCircle2 className="size-6 text-brand" />
            <h2 className="mt-6 text-xl font-semibold">{page.principleTitle}</h2>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              {page.principle}
            </p>
          </aside>
        </div>
      </section>
    </div>
  );
}
